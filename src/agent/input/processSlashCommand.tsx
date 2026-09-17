import { feature } from 'bun:bundle';
import type { ContentBlockParam, TextBlockParam } from '@anthropic-ai/sdk/resources';
import { randomUUID } from 'crypto';
import { setPromptId } from 'src/platform/bootstrap/state.js';
import { type Command, type CommandBase, findCommand, getCommand, getCommandName, hasCommand, type PromptCommand } from 'src/commands/commands.js';
import { NO_CONTENT_MESSAGE } from 'src/agent/prompts/messages.js';
import type { SetToolJSXFn, ToolUseContext } from 'src/tools/Tool.js';
import type { AssistantMessage, AttachmentMessage, Message, NormalizedUserMessage, ProgressMessage, UserMessage } from 'src/shared/types/message.js';
import { addInvokedSkill, getSessionId } from 'src/platform/bootstrap/state.js';
import { COMMAND_MESSAGE_TAG, COMMAND_NAME_TAG } from 'src/shared/constants/xml.js';
import type { CanUseToolFn } from 'src/permissions/useCanUseTool.js';
import { buildPostCompactMessages } from 'src/agent/compact/compact.js';
import { resetMicrocompactState } from 'src/agent/compact/microCompact.js';
import type { Progress as AgentProgress } from 'src/tools/AgentTool/AgentTool.js';
import { runAgent } from 'src/tools/AgentTool/runAgent.js';
import { renderToolUseProgressMessage } from 'src/tools/AgentTool/UI.js';
import type { CommandResultDisplay } from 'src/shared/types/command.js';
import { getAgentContext } from 'src/agent/coordinator/agentContext.js';
import { createAttachmentMessage, getAttachmentMessages } from 'src/agent/attachments/attachments.js';
import { logForDebugging } from 'src/shared/debug.js';
import { isEnvTruthy } from 'src/shared/envUtils.js';
import { AbortError, MalformedCommandError } from 'src/shared/errors.js';
import { extractResultText, prepareForkedCommandContext } from 'src/agent/coordinator/forkedAgent.js';
import { getFsImplementation } from 'src/shared/fs/fsOperations.js';
import { isFullscreenEnvEnabled } from 'src/terminal/render/fullscreen.js';
import { toArray } from 'src/shared/generators.js';
import { registerSkillHooks } from 'src/platform/lifecycleHooks/registerSkillHooks.js';
import { logError } from 'src/shared/log.js';
import { getCurrentLocalJSXGeneration } from 'src/terminal/toolJSXStore.js';
import { createCommandInputMessage, createSyntheticUserCaveatMessage, createSystemMessage, createUserInterruptionMessage, createUserMessage, formatCommandInputTags, isCompactBoundaryMessage, isSystemLocalCommandMessage, normalizeMessages, prepareUserContent } from 'src/agent/messages/messages.js';
import type { ModelAlias } from 'src/providers/model/aliases.js';
import { parseToolListFromCLI } from 'src/permissions/permissionSetup.js';
import { hasPermissionsToUseTool } from 'src/permissions/permissions.js';
import { isRestrictedToPluginOnly, isSourceAdminTrusted } from 'src/platform/settings/pluginOnlyPolicy.js';
import { parseSlashCommand } from 'src/commands/slashCommandParsing.js';
import { recordSkillUsage } from 'src/terminal/suggestions/skillUsageTracking.js';
import { getAssistantMessageContentLength } from 'src/agent/context/tokens.js';
import { createAgentId } from 'src/shared/data/uuid.js';
import type { ProcessUserInputBaseResult, ProcessUserInputContext } from 'src/agent/input/processUserInput.js';
type SlashCommandResult = ProcessUserInputBaseResult & {
  command: Command;
};

/**
 * Executes a slash command with context: fork in a sub-agent.
 */
async function executeForkedSlashCommand(command: CommandBase & PromptCommand, args: string, context: ProcessUserInputContext, precedingInputBlocks: ContentBlockParam[], setToolJSX: SetToolJSXFn, canUseTool: CanUseToolFn): Promise<SlashCommandResult> {
  const agentId = createAgentId();
  const {
    skillContent,
    modifiedGetAppState,
    baseAgent,
    promptMessages
  } = await prepareForkedCommandContext(command, args, context);

  // Merge skill's effort into the agent definition so runAgent applies it
  const agentDefinition = command.effort !== undefined ? {
    ...baseAgent,
    effort: command.effort
  } : baseAgent;
  logForDebugging(`Executing forked slash command /${command.name} with agent ${agentDefinition.agentType}`);

  // Collect messages from the forked agent
  const agentMessages: Message[] = [];

  // Build progress messages for the agent progress UI
  const progressMessages: ProgressMessage<AgentProgress>[] = [];
  const parentToolUseID = `forked-command-${command.name}`;
  let toolUseCounter = 0;

  // Helper to create a progress message from an agent message
  const createProgressMessage = (message: AssistantMessage | NormalizedUserMessage): ProgressMessage<AgentProgress> => {
    toolUseCounter++;
    return {
      type: 'progress',
      data: {
        message,
        type: 'agent_progress',
        prompt: skillContent,
        agentId
      },
      parentToolUseID,
      toolUseID: `${parentToolUseID}-${toolUseCounter}`,
      timestamp: new Date().toISOString(),
      uuid: randomUUID()
    };
  };

  // Helper to update progress display using agent progress UI
  const updateProgress = (): void => {
    setToolJSX({
      jsx: renderToolUseProgressMessage(progressMessages, {
        tools: context.options.tools,
        verbose: false
      }),
      shouldHidePromptInput: false,
      shouldContinueAnimation: true,
      showSpinner: true
    });
  };

  // Show initial "Initializing…" state
  updateProgress();

  // Run the sub-agent
  try {
    for await (const message of runAgent({
      agentDefinition,
      promptMessages,
      toolUseContext: {
        ...context,
        getAppState: modifiedGetAppState
      },
      canUseTool,
      isAsync: false,
      querySource: 'agent:custom',
      model: command.model as ModelAlias | undefined,
      availableTools: context.options.tools
    })) {
      agentMessages.push(message);
      const normalizedNew = normalizeMessages([message]);

      // Add progress message for assistant messages (which contain tool uses)
      if (message.type === 'assistant') {
        // Increment token count in spinner for assistant messages
        const contentLength = getAssistantMessageContentLength(message);
        if (contentLength > 0) {
          context.setResponseLength(len => len + contentLength);
        }
        const normalizedMsg = normalizedNew[0];
        if (normalizedMsg && normalizedMsg.type === 'assistant') {
          progressMessages.push(createProgressMessage(message));
          updateProgress();
        }
      }

      // Add progress message for user messages (which contain tool results)
      if (message.type === 'user') {
        const normalizedMsg = normalizedNew[0];
        if (normalizedMsg && normalizedMsg.type === 'user') {
          progressMessages.push(createProgressMessage(normalizedMsg));
          updateProgress();
        }
      }
    }
  } finally {
    // Clear the progress display
    setToolJSX(null);
  }
  let resultText = extractResultText(agentMessages, 'Command completed');
  logForDebugging(`Forked slash command /${command.name} completed with agent ${agentId}`);

  // Return the result as a user message (simulates the agent's output)
  const messages: UserMessage[] = [createUserMessage({
    content: prepareUserContent({
      inputString: `/${getCommandName(command)} ${args}`.trim(),
      precedingInputBlocks
    })
  }), createUserMessage({
    content: `<local-command-stdout>\n${resultText}\n</local-command-stdout>`
  })];
  return {
    messages,
    shouldQuery: false,
    command,
    resultText
  };
}

/**
 * Determines if a string looks like a valid command name.
 * Valid command names only contain letters, numbers, colons, hyphens, and underscores.
 *
 * @param commandName - The potential command name to check
 * @returns true if it looks like a command name, false if it contains non-command characters
 */
export function looksLikeCommand(commandName: string): boolean {
  // Command names should only contain [a-zA-Z0-9:_-]
  // If it contains other characters, it's probably a file path or other input
  return !/[^a-zA-Z0-9:\-_]/.test(commandName);
}
export async function processSlashCommand(inputString: string, precedingInputBlocks: ContentBlockParam[], imageContentBlocks: ContentBlockParam[], attachmentMessages: AttachmentMessage[], context: ProcessUserInputContext, setToolJSX: SetToolJSXFn, uuid?: string, isAlreadyProcessing?: boolean, canUseTool?: CanUseToolFn): Promise<ProcessUserInputBaseResult> {
  const parsed = parseSlashCommand(inputString);
  if (!parsed) {
    const errorMessage = 'Commands are in the form `/command [args]`';
    return {
      messages: [createSyntheticUserCaveatMessage(), ...attachmentMessages, createUserMessage({
        content: prepareUserContent({
          inputString: errorMessage,
          precedingInputBlocks
        })
      })],
      shouldQuery: false,
      resultText: errorMessage
    };
  }
  const {
    commandName,
    args: parsedArgs
  } = parsed;

  // Check if it's a real command before processing
  if (!hasCommand(commandName, context.options.commands)) {
    // Check if this looks like a command name vs a file path or other input
    // Also check if it's an actual file path that exists
    let isFilePath = false;
    try {
      await getFsImplementation().stat(`/${commandName}`);
      isFilePath = true;
    } catch {
      // Not a file path — treat as command name
    }
    if (looksLikeCommand(commandName) && !isFilePath) {
      const unknownMessage = `Unknown skill: ${commandName}`;
      return {
        messages: [createSyntheticUserCaveatMessage(), ...attachmentMessages, createUserMessage({
          content: prepareUserContent({
            inputString: unknownMessage,
            precedingInputBlocks
          })
        }),
        // gh-32591: preserve args so the user can copy/resubmit without
        // retyping. System warning is UI-only (filtered before API).
        ...(parsedArgs ? [createSystemMessage(`Args from unknown skill: ${parsedArgs}`, 'warning')] : [])],
        shouldQuery: false,
        resultText: unknownMessage
      };
    }
    const promptId = randomUUID();
    setPromptId(promptId);
    return {
      messages: [createUserMessage({
        content: prepareUserContent({
          inputString,
          precedingInputBlocks
        }),
        uuid: uuid
      }), ...attachmentMessages],
      shouldQuery: true
    };
  }

  const {
    messages: newMessages,
    shouldQuery: messageShouldQuery,
    allowedTools,
    model,
    effort,
    resultText,
    nextInput,
    submitNextInput
  } = await getMessagesForSlashCommand(commandName, parsedArgs, setToolJSX, context, precedingInputBlocks, imageContentBlocks, isAlreadyProcessing, canUseTool, uuid);

  // Local slash commands that skip messages
  if (newMessages.length === 0) {
    return {
      messages: [],
      shouldQuery: false,
      model,
      nextInput,
      submitNextInput
    };
  }

  // For invalid commands, preserve both the user message and error
  if (newMessages.length === 2 && newMessages[1]!.type === 'user' && typeof newMessages[1]!.message.content === 'string' && newMessages[1]!.message.content.startsWith('Unknown command:')) {
    return {
      messages: [createSyntheticUserCaveatMessage(), ...newMessages],
      shouldQuery: messageShouldQuery,
      allowedTools,
      model
    };
  }

  // A valid command
  // Check if this is a compact result which handle their own synthetic caveat message ordering
  const isCompactResult = newMessages.length > 0 && newMessages[0] && isCompactBoundaryMessage(newMessages[0]);
  return {
    messages: messageShouldQuery || newMessages.every(isSystemLocalCommandMessage) || isCompactResult ? newMessages : [createSyntheticUserCaveatMessage(), ...newMessages],
    shouldQuery: messageShouldQuery,
    allowedTools,
    model,
    effort,
    resultText,
    nextInput,
    submitNextInput
  };
}
async function getMessagesForSlashCommand(commandName: string, args: string, setToolJSX: SetToolJSXFn, context: ProcessUserInputContext, precedingInputBlocks: ContentBlockParam[], imageContentBlocks: ContentBlockParam[], _isAlreadyProcessing?: boolean, canUseTool?: CanUseToolFn, uuid?: string): Promise<SlashCommandResult> {
  const command = getCommand(commandName, context.options.commands);

  // Track skill usage for ranking (only for prompt commands that are user-invocable)
  if (command.type === 'prompt' && command.userInvocable !== false) {
    recordSkillUsage(commandName);
  }

  // Check if the command is user-invocable
  // Skills with userInvocable === false can only be invoked by the model via SkillTool
  if (command.userInvocable === false) {
    return {
      messages: [createUserMessage({
        content: prepareUserContent({
          inputString: `/${commandName}`,
          precedingInputBlocks
        })
      }), createUserMessage({
        content: `This skill can only be invoked by Claude, not directly by users. Ask Claude to use the "${commandName}" skill for you.`
      })],
      shouldQuery: false,
      command
    };
  }
  try {
    switch (command.type) {
      case 'local-jsx':
        {
          return new Promise<SlashCommandResult>(resolve => {
            let doneWasCalled = false;
            const onDone = (result?: string, options?: {
              display?: CommandResultDisplay;
              shouldQuery?: boolean;
              metaMessages?: string[];
              nextInput?: string;
              submitNextInput?: boolean;
            }) => {
              doneWasCalled = true;
              // If display is 'skip', don't add any messages to the conversation
              if (options?.display === 'skip') {
                void resolve({
                  messages: [],
                  shouldQuery: false,
                  command,
                  nextInput: options?.nextInput,
                  submitNextInput: options?.submitNextInput
                });
                return;
              }

              // Meta messages are model-visible but hidden from the user
              const metaMessages = (options?.metaMessages ?? []).map((content: string) => createUserMessage({
                content,
                isMeta: true
              }));

              // In fullscreen the command just showed as a centered modal
              // pane — the transient notification is enough feedback. The
              // "❯ /config" + "⎿ dismissed" transcript entries are
              // type:system subtype:local_command (user-visible but NOT sent
              // to the model), so skipping them doesn't affect model context.
              // Outside fullscreen keep them so scrollback shows what ran.
              // Only skip "<Name> dismissed" modal-close notifications —
              // commands that early-exit before showing a modal (/rename,
              // /proactive) use display:system for actual output that must
              // reach the transcript.
              const skipTranscript = isFullscreenEnvEnabled() && typeof result === 'string' && result.endsWith(' dismissed');
              void resolve({
                messages: options?.display === 'system' ? skipTranscript ? metaMessages : [createCommandInputMessage(formatCommandInput(command, args)), createCommandInputMessage(`<local-command-stdout>${result}</local-command-stdout>`), ...metaMessages] : [createUserMessage({
                  content: prepareUserContent({
                    inputString: formatCommandInput(command, args),
                    precedingInputBlocks
                  })
                }), result ? createUserMessage({
                  content: `<local-command-stdout>${result}</local-command-stdout>`
                }) : createUserMessage({
                  content: `<local-command-stdout>${NO_CONTENT_MESSAGE}</local-command-stdout>`
                }), ...metaMessages],
                shouldQuery: options?.shouldQuery ?? false,
                command,
                nextInput: options?.nextInput,
                submitNextInput: options?.submitNextInput
              });
            };
            // Capture the generation token BEFORE any await. If a
            // clearLocalJSX:true fires before our late set lands, the
            // store will drop our stale write — see toolJSXStore.ts.
            const generation = getCurrentLocalJSXGeneration();
            void command.load().then(mod => mod.call(onDone, {
              ...context,
              canUseTool
            }, args)).then(jsx => {
              if (jsx == null) return;
              if (context.options.isNonInteractiveSession) {
                void resolve({
                  messages: [],
                  shouldQuery: false,
                  command
                });
                return;
              }
              // doneWasCalled guards the synchronous onDone-then-return-jsx
              // case; the generation token guards the async race where
              // onDone is never called and a separate path issues a clear.
              if (doneWasCalled) return;
              setToolJSX({
                jsx,
                // A side-panel command sits BESIDE the chat, so the prompt has
                // to stay mounted and typable. Only in fullscreen: inline there
                // is no panel, and the prompt would render under the dialog.
                shouldHidePromptInput: !(command.fullscreenPanel === true && isFullscreenEnvEnabled()),
                showSpinner: false,
                isLocalJSXCommand: true,
                isImmediate: command.immediate === true,
                generation
              });
            }).catch(e => {
              // If load()/call() throws and onDone never fired, the outer
              // Promise hangs forever, leaving queryGuard stuck in
              // 'dispatching' and deadlocking the queue processor.
              logError(e);
              if (doneWasCalled) return;
              doneWasCalled = true;
              setToolJSX({
                jsx: null,
                shouldHidePromptInput: false,
                clearLocalJSX: true
              });
              void resolve({
                messages: [],
                shouldQuery: false,
                command
              });
            });
          });
        }
      case 'local':
        {
          const displayArgs = command.isSensitive && args.trim() ? '***' : args;
          const userMessage = createUserMessage({
            content: prepareUserContent({
              inputString: formatCommandInput(command, displayArgs),
              precedingInputBlocks
            })
          });
          try {
            const syntheticCaveatMessage = createSyntheticUserCaveatMessage();
            const mod = await command.load();
            const result = await mod.call(args, context);
            if (result.type === 'skip') {
              return {
                messages: [],
                shouldQuery: false,
                command
              };
            }

            // Use discriminated union to handle different result types
            if (result.type === 'compact') {
              // Append slash command messages to messagesToKeep so that
              // attachments and hookResults come after user messages
              const slashCommandMessages = [syntheticCaveatMessage, userMessage, ...(result.displayText ? [createUserMessage({
                content: `<local-command-stdout>${result.displayText}</local-command-stdout>`,
                // --resume looks at latest timestamp message to determine which message to resume from
                // This is a perf optimization to avoid having to recaculcate the leaf node every time
                // Since we're creating a bunch of synthetic messages for compact, it's important to set
                // the timestamp of the last message to be slightly after the current time
                // This is mostly important for sdk / -p mode
                timestamp: new Date(Date.now() + 100).toISOString()
              })] : [])];
              const compactionResultWithSlashMessages = {
                ...result.compactionResult,
                messagesToKeep: [...(result.compactionResult.messagesToKeep ?? []), ...slashCommandMessages]
              };
              // Reset microcompact state since full compact replaces all
              // messages — old tool IDs are no longer relevant. Budget state
              // (on toolUseContext) needs no reset: stale entries are inert
              // (UUIDs never repeat, so they're never looked up).
              resetMicrocompactState();
              return {
                messages: buildPostCompactMessages(compactionResultWithSlashMessages),
                shouldQuery: false,
                command
              };
            }

            // Text result — use system message so it doesn't render as a user bubble
            return {
              messages: [userMessage, createCommandInputMessage(`<local-command-stdout>${result.value}</local-command-stdout>`)],
              shouldQuery: false,
              command,
              resultText: result.value
            };
          } catch (e) {
            logError(e);
            return {
              messages: [userMessage, createCommandInputMessage(`<local-command-stderr>${String(e)}</local-command-stderr>`)],
              shouldQuery: false,
              command
            };
          }
        }
      case 'prompt':
        {
          try {
            // Check if command should run as forked sub-agent
            if (command.context === 'fork') {
              return await executeForkedSlashCommand(command, args, context, precedingInputBlocks, setToolJSX, canUseTool ?? hasPermissionsToUseTool);
            }
            return await getMessagesForPromptSlashCommand(command, args, context, precedingInputBlocks, imageContentBlocks, uuid);
          } catch (e) {
            // Handle abort errors specially to show proper "Interrupted" message
            if (e instanceof AbortError) {
              return {
                messages: [createUserMessage({
                  content: prepareUserContent({
                    inputString: formatCommandInput(command, args),
                    precedingInputBlocks
                  })
                }), createUserInterruptionMessage({
                  toolUse: false
                })],
                shouldQuery: false,
                command
              };
            }
            return {
              messages: [createUserMessage({
                content: prepareUserContent({
                  inputString: formatCommandInput(command, args),
                  precedingInputBlocks
                })
              }), createUserMessage({
                content: `<local-command-stderr>${String(e)}</local-command-stderr>`
              })],
              shouldQuery: false,
              command
            };
          }
        }
    }
  } catch (e) {
    if (e instanceof MalformedCommandError) {
      return {
        messages: [createUserMessage({
          content: prepareUserContent({
            inputString: e.message,
            precedingInputBlocks
          })
        })],
        shouldQuery: false,
        command
      };
    }
    throw e;
  }
}
function formatCommandInput(command: CommandBase, args: string): string {
  return formatCommandInputTags(getCommandName(command), args);
}

/**
 * Formats the metadata for a skill loading message.
 * Used by the Skill tool and for subagent skill preloading.
 */
export function formatSkillLoadingMetadata(skillName: string, _progressMessage: string = 'loading'): string {
  // Use skill name only - UserCommandMessage renders as "Skill(name)"
  return [`<${COMMAND_MESSAGE_TAG}>${skillName}</${COMMAND_MESSAGE_TAG}>`, `<${COMMAND_NAME_TAG}>${skillName}</${COMMAND_NAME_TAG}>`, `<skill-format>true</skill-format>`].join('\n');
}

/**
 * Formats the metadata for a slash command loading message.
 */
function formatSlashCommandLoadingMetadata(commandName: string, args?: string): string {
  return [`<${COMMAND_MESSAGE_TAG}>${commandName}</${COMMAND_MESSAGE_TAG}>`, `<${COMMAND_NAME_TAG}>/${commandName}</${COMMAND_NAME_TAG}>`, args ? `<command-args>${args}</command-args>` : null].filter(Boolean).join('\n');
}

/**
 * Formats the loading metadata for a command (skill or slash command).
 * User-invocable skills use slash command format (/name), while model-only
 * skills use the skill format ("The X skill is running").
 */
function formatCommandLoadingMetadata(command: CommandBase & PromptCommand, args?: string): string {
  // Use command.name (the qualified name including plugin prefix, e.g.
  // "product-management:feature-spec") instead of userFacingName() which may
  // strip the plugin prefix via displayName fallback.
  // User-invocable skills should show as /command-name like regular slash commands
  if (command.userInvocable !== false) {
    return formatSlashCommandLoadingMetadata(command.name, args);
  }
  // Model-only skills (userInvocable: false) show as "The X skill is running"
  if (command.loadedFrom === 'skills' || command.loadedFrom === 'plugin' || command.loadedFrom === 'mcp') {
    return formatSkillLoadingMetadata(command.name, command.progressMessage);
  }
  return formatSlashCommandLoadingMetadata(command.name, args);
}
export async function processPromptSlashCommand(commandName: string, args: string, commands: Command[], context: ToolUseContext, imageContentBlocks: ContentBlockParam[] = []): Promise<SlashCommandResult> {
  const command = findCommand(commandName, commands);
  if (!command) {
    throw new MalformedCommandError(`Unknown command: ${commandName}`);
  }
  if (command.type !== 'prompt') {
    throw new Error(`Unexpected ${command.type} command. Expected 'prompt' command. Use /${commandName} directly in the main conversation.`);
  }
  return getMessagesForPromptSlashCommand(command, args, context, [], imageContentBlocks);
}
async function getMessagesForPromptSlashCommand(command: CommandBase & PromptCommand, args: string, context: ToolUseContext, precedingInputBlocks: ContentBlockParam[] = [], imageContentBlocks: ContentBlockParam[] = [], uuid?: string): Promise<SlashCommandResult> {
  // In coordinator mode (main thread only), skip loading the full skill content
  // and permissions. The coordinator only has Agent + TaskStop tools, so the
  // skill content and allowedTools are useless. Instead, send a brief summary
  // telling the coordinator how to delegate this skill to a worker.
  //
  // Workers run in-process and inherit CLAUDIN_COORDINATOR_MODE from the
  // parent env, so we also check !context.agentId: agentId is only set for
  // subagents, letting workers fall through to getPromptForCommand and receive
  // the real skill content when they invoke the Skill tool.
  if (feature('COORDINATOR_MODE') && isEnvTruthy(process.env.CLAUDIN_COORDINATOR_MODE) && !context.agentId) {
    const metadata = formatCommandLoadingMetadata(command, args);
    const parts: string[] = [`Skill "/${command.name}" is available for workers.`];
    if (command.description) {
      parts.push(`Description: ${command.description}`);
    }
    if (command.whenToUse) {
      parts.push(`When to use: ${command.whenToUse}`);
    }
    const skillAllowedTools = command.allowedTools ?? [];
    if (skillAllowedTools.length > 0) {
      parts.push(`This skill grants workers additional tool permissions: ${skillAllowedTools.join(', ')}`);
    }
    parts.push(`\nInstruct a worker to use this skill by including "Use the /${command.name} skill" in your Agent prompt. The worker has access to the Skill tool and will receive the skill's content and permissions when it invokes it.`);
    const summaryContent: ContentBlockParam[] = [{
      type: 'text',
      text: parts.join('\n')
    }];
    return {
      messages: [createUserMessage({
        content: metadata,
        uuid
      }), createUserMessage({
        content: summaryContent,
        isMeta: true
      })],
      shouldQuery: true,
      model: command.model,
      effort: command.effort,
      command
    };
  }
  const result = await command.getPromptForCommand(args, context);

  // Register skill hooks if defined. Under ["hooks"]-only (skills not locked),
  // user skills still load and reach this point — block hook REGISTRATION here
  // where source is known. Mirrors the agent frontmatter gate in runAgent.ts.
  const hooksAllowedForThisSkill = !isRestrictedToPluginOnly('hooks') || isSourceAdminTrusted(command.source);
  if (command.hooks && hooksAllowedForThisSkill) {
    const sessionId = getSessionId();
    registerSkillHooks(context.setAppState, sessionId, command.hooks, command.name, command.type === 'prompt' ? command.skillRoot : undefined);
  }

  // Record skill invocation for compaction preservation, scoped by agent context.
  // Skills are tagged with their agentId so only skills belonging to the current
  // agent are restored during compaction (preventing cross-agent leaks).
  const skillPath = command.source ? `${command.source}:${command.name}` : command.name;
  const skillContent = result.filter((b): b is TextBlockParam => b.type === 'text').map(b => b.text).join('\n\n');
  addInvokedSkill(command.name, skillPath, skillContent, getAgentContext()?.agentId ?? null);
  const metadata = formatCommandLoadingMetadata(command, args);
  const additionalAllowedTools = parseToolListFromCLI(command.allowedTools ?? []);

  // Create content for the main message, including any pasted images
  const mainMessageContent: ContentBlockParam[] = imageContentBlocks.length > 0 || precedingInputBlocks.length > 0 ? [...imageContentBlocks, ...precedingInputBlocks, ...result] : result;

  // Extract attachments from command arguments (@-mentions, MCP resources,
  // agent mentions in SKILL.md). skipSkillDiscovery prevents the SKILL.md
  // content itself from triggering discovery — it's meta-content, not user
  // intent, and a large SKILL.md (e.g. 110KB) would fire chunked AKI queries
  // adding seconds of latency to every skill invocation.
  const attachmentMessages = await toArray(getAttachmentMessages(result.filter((block): block is TextBlockParam => block.type === 'text').map(block => block.text).join(' '), context, null, [],
  // queuedCommands - handled by query.ts for mid-turn attachments
  context.messages, 'repl_main_thread', {
    skipSkillDiscovery: true
  }));
  const messages = [createUserMessage({
    content: metadata,
    uuid
  }), createUserMessage({
    content: mainMessageContent,
    isMeta: true
  }), ...attachmentMessages, createAttachmentMessage({
    type: 'command_permissions',
    allowedTools: additionalAllowedTools,
    model: command.model
  })];
  return {
    messages,
    shouldQuery: true,
    allowedTools: additionalAllowedTools,
    model: command.model,
    effort: command.effort,
    command
  };
}
