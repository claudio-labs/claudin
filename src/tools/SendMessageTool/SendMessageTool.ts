/**
 * SendMessage — one agent writing to another: a background agent it spawned
 * (resumed from its transcript when it has stopped), the main conversation
 * (`"main"`, from a background agent), another Claudin session on this machine
 * (through its peer inbox, src/sessions/peers/), and — inside an agent team —
 * its teammates.
 *
 * On by default. CLAUDIN_DISABLE_SEND_MESSAGE=1 removes it again outside an
 * agent team, where the swarm protocol still needs it.
 */
import { randomUUID } from 'crypto'
import { z } from 'zod/v4'
import type { Tool, ToolUseContext } from 'src/tools/Tool.js'
import { buildTool, type ToolDef } from 'src/tools/Tool.js'
import { enqueue } from 'src/agent/messageQueueManager.js'
import { findTeammateTaskByAgentId } from 'src/agent/tasks/InProcessTeammateTask/InProcessTeammateTask.js'
import {
  isLocalAgentTask,
  queuePendingMessage,
} from 'src/agent/tasks/LocalAgentTask/LocalAgentTask.js'
import { isMainSessionTask } from 'src/agent/tasks/LocalMainSessionTask.js'
import { toAgentId } from 'src/shared/types/ids.js'
import { generateRequestId } from 'src/agent/coordinator/agentId.js'
import { isAgentSwarmsEnabled } from 'src/agent/coordinator/agentSwarmsEnabled.js'
import { logForDebugging } from 'src/shared/debug.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { errorMessage } from 'src/shared/errors.js'
import { gracefulShutdown } from 'src/shared/proc/gracefulShutdown.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import { formatUdsAddress, parseAddress } from 'src/sessions/peers/address.js'
import { PeerDeliveryError, sendFrame } from 'src/sessions/peers/client.js'
import {
  FRAME_VERSION,
  MESSAGE_MAX_CHARS,
  type ResponseFrame,
} from 'src/sessions/peers/frames.js'
import {
  crossSessionUnavailableReason,
  getOwnInbox,
} from 'src/sessions/peers/inboxServer.js'
import { permissionClassOf } from 'src/sessions/peers/policy.js'
import { awaitDeliveryStatus } from 'src/sessions/peers/notices.js'
import {
  awaitIdleNotice,
  forgetAwaitedIdleNotices,
  takeAwaitedIdleNotice,
} from 'src/sessions/peers/subscriptions.js'
import {
  type PeerSession,
  readSessionDirectory,
  resolvePeerTarget,
} from 'src/sessions/peers/registry.js'
import {
  CROSS_SESSION_SENDS_PER_USER_PROMPT,
  AGENT_SENDS_PER_AGENT,
  takeAgentSend,
  takeCrossSessionSend,
} from 'src/sessions/peers/sendBudget.js'
import { semanticBoolean } from 'src/shared/data/semanticBoolean.js'
import { CROSS_SESSION_MESSAGE_TAG } from 'src/shared/constants/xml.js'
import { parseXmlEnvelope } from 'src/shared/data/xml.js'
import { jsonStringify } from 'src/platform/slowOperations.js'
import type { BackendType } from 'src/agent/coordinator/swarm/backends/types.js'
import { TEAM_LEAD_NAME } from 'src/agent/coordinator/swarm/constants.js'
import { readTeamFileAsync } from 'src/agent/coordinator/swarm/teamHelpers.js'
import {
  getAgentId,
  getAgentName,
  getTeammateColor,
  getTeamName,
  isTeamLead,
  isTeammate,
} from 'src/agent/coordinator/teammate.js'
import {
  createShutdownApprovedMessage,
  createShutdownRejectedMessage,
  createShutdownRequestMessage,
  writeToMailbox,
} from 'src/agent/coordinator/teammateMailbox.js'
import { resumeAgentBackground } from 'src/tools/AgentTool/resumeAgent.js'
import type { CanUseToolFn } from 'src/permissions/useCanUseTool.js'
import { formatAgentMessage } from 'src/tools/SendMessageTool/agentMessage.js'
import { resumeOnce } from 'src/tools/SendMessageTool/resumeOnce.js'
import {
  awaitReply,
  describeAwaitOutcome,
  inSessionProbe,
} from 'src/tools/SendMessageTool/awaitReply.js'
import { LIST_AGENTS_TOOL_NAME } from 'src/tools/ListAgentsTool/constants.js'
import { MAIN_ADDRESS, SEND_MESSAGE_TOOL_NAME } from 'src/tools/SendMessageTool/constants.js'
import { DESCRIPTION, getPrompt } from 'src/tools/SendMessageTool/prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from 'src/tools/SendMessageTool/UI.js'

const StructuredMessage = lazySchema(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('shutdown_request'),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal('shutdown_response'),
      request_id: z.string(),
      approve: semanticBoolean(),
      reason: z.string().optional(),
    }),
    z.object({
      type: z.literal('plan_approval_response'),
      request_id: z.string(),
      approve: semanticBoolean(),
      feedback: z.string().optional(),
    }),
  ]),
)

const SUMMARY_MAX_CHARS = 200
const TO_MAX_CHARS = 1024
const SINGLE_LINE_RE = /^[^\n\r]*$/

const MESSAGE_DESCRIPTION =
  "Plain text message content. The recipient's human sees only the FIRST LINE as a one-line preview until they expand it, so make the first line a clear, self-contained sentence saying what this is about — not a greeting, preamble, or bare @-mention."

const NOTIFY_WHEN_IDLE_DESCRIPTION =
  'Ask a session ON THIS MACHINE to send you ONE notice when it next goes idle (finishes its turn with nothing queued) or exits — opt-in, one-shot, no polling. With a message: deliver it now AND subscribe. Without a message (omit it): a pure subscription that costs the other session nothing, answered at once if it is already idle.'

const AWAIT_REPLY_DESCRIPTION =
  "Only when you cannot go on without the answer: keep this call open until the recipient answers. Returns the first message sent to you (check who sent it — it may not be the reply), or the recipient's end — an agent stopping, a session going idle — if that comes first; gives up after 10 minutes. Without a message (omit it): only wait — how to keep waiting after a timeout."

type SchemaVariant = { swarm: boolean; crossSession: boolean }

function describeTo({ swarm, crossSession }: SchemaVariant): string {
  const name = crossSession
    ? `a name from ${LIST_AGENTS_TOOL_NAME} (append its " [ref]" only when a listing or an error shows one)`
    : `a name from ${LIST_AGENTS_TOOL_NAME}`
  return swarm
    ? `Recipient: ${name}, a teammate name, "*" for the whole team, "main", or a background agent's agentId`
    : `Recipient: ${name}, "main", or a background agent's agentId`
}

function describeSummary(swarm: boolean): string {
  return swarm
    ? `A 5-10 word summary: your transcript row, and the preview a teammate sees. Defaults to the first line of \`message\`; truncated to ${SUMMARY_MAX_CHARS} characters rather than rejected.`
    : `A 5-10 word label for your own transcript row, not sent — the recipient reads \`message\`. Defaults to its first line; truncated to ${SUMMARY_MAX_CHARS} characters rather than rejected.`
}

// Only here to name the widest variant's type; inputSchemaFor builds the
// schemas, and every variant accepts a subset of what this one does.
const widestInputSchema = () =>
  z.object({
    to: z.string(),
    summary: z.string().optional(),
    message: z.union([z.string(), StructuredMessage()]).optional(),
    notify_when_idle: semanticBoolean(z.boolean().optional()),
    await_reply: semanticBoolean(z.boolean().optional()),
  })
type InputSchema = ReturnType<typeof widestInputSchema>

const inputSchemas = new Map<string, InputSchema>()

/**
 * Structured protocol messages and `"*"` exist only inside an agent team, so
 * outside one the schema offers plain text alone — the model is not shown
 * shapes it can never send. Each variant is built once, keeping the schema
 * byte-stable across requests. buildTool spreads the tool definition, so the
 * `inputSchema` getter below runs once, when this module loads.
 */
export function inputSchemaFor(variant: SchemaVariant): InputSchema {
  const { swarm } = variant
  const key = `swarm=${swarm}:crossSession=${variant.crossSession}`
  const cached = inputSchemas.get(key)
  if (cached) return cached
  const text = z.string().describe(MESSAGE_DESCRIPTION)
  const message = swarm ? z.union([text, StructuredMessage()]) : text
  const awaitReply = semanticBoolean(z.boolean().optional()).describe(AWAIT_REPLY_DESCRIPTION)
  // Only a session on this machine can be subscribed to, so only a schema
  // that can reach one offers notify_when_idle. `message` is optional in both:
  // `await_reply` without one only waits.
  const schema = (
    variant.crossSession
      ? z.object({
          to: z.string().describe(describeTo(variant)),
          summary: z.string().optional().describe(describeSummary(swarm)),
          message: message.optional(),
          notify_when_idle: semanticBoolean(z.boolean().optional()).describe(
            NOTIFY_WHEN_IDLE_DESCRIPTION,
          ),
          await_reply: awaitReply,
        })
      : z.object({
          to: z.string().describe(describeTo(variant)),
          summary: z.string().optional().describe(describeSummary(swarm)),
          message: message.optional(),
          await_reply: awaitReply,
        })
  ) as unknown as InputSchema
  inputSchemas.set(key, schema)
  return schema
}

export type Input = z.infer<InputSchema>

export type MessageRouting = {
  sender: string
  senderColor?: string
  target: string
  targetColor?: string
  summary?: string
  content?: string
}

export type MessageOutput = {
  success: boolean
  message: string
  routing?: MessageRouting
  /** What arrived while `await_reply` waited — the envelopes, verbatim. */
  replies?: string[]
}

export type BroadcastOutput = {
  success: boolean
  message: string
  recipients: string[]
  routing?: MessageRouting
}

export type RequestOutput = {
  success: boolean
  message: string
  request_id: string
  target: string
}

export type ResponseOutput = {
  success: boolean
  message: string
  request_id?: string
}

export type SendMessageToolOutput =
  | MessageOutput
  | BroadcastOutput
  | RequestOutput
  | ResponseOutput

function findTeammateColor(
  appState: {
    teamContext?: { teammates: { [id: string]: { color?: string } } }
  },
  name: string,
): string | undefined {
  const teammates = appState.teamContext?.teammates
  if (!teammates) return undefined
  for (const teammate of Object.values(teammates)) {
    if ('name' in teammate && (teammate as { name: string }).name === name) {
      return teammate.color
    }
  }
  return undefined
}

/** The label a send is shown under: the given summary, else the first line. */
function resolveSummary(summary: string | undefined, message: string): string {
  const label = summary?.trim() || (message.trim().split('\n')[0] ?? '')
  return label.length > SUMMARY_MAX_CHARS
    ? `${label.slice(0, SUMMARY_MAX_CHARS - 1)}…`
    : label
}

function findAgentName(
  registry: Map<string, string>,
  agentId: string,
): string | undefined {
  let found: string | undefined
  // Latest registration wins, the same way a send by name resolves.
  for (const [name, id] of registry) if (id === agentId) found = name
  return found
}

/**
 * The address a reply to this sender goes to — "main", the agent's name, or
 * its agentId — and, for an agent without a name, the description the
 * receiver's transcript shows instead of the id.
 */
function senderOf(context: ToolUseContext): { from: string; description?: string } {
  const { agentId } = context
  if (agentId === undefined) return { from: MAIN_ADDRESS }
  const appState = context.getAppState()
  const name = findAgentName(appState.agentNameRegistry, agentId)
  if (name !== undefined) return { from: name }
  const task = appState.tasks[agentId]
  return { from: agentId, description: isLocalAgentTask(task) ? task.description : undefined }
}

/** One message to another agent of this conversation, against the sender's budget. */
function spendAgentSend(context: ToolUseContext): void {
  if (takeAgentSend(context.agentId ?? MAIN_ADDRESS)) return
  throw new Error(
    `You have sent ${AGENT_SENDS_PER_AGENT} messages to other agents — the limit that stops two agents looping with no human in it. ${context.agentId === undefined ? 'Tell the user where things stand instead.' : 'Put what is left in your final report instead.'}`,
  )
}

/**
 * The agent of this conversation `to` names — by its registered name or its
 * raw agentId — the way a send resolves it.
 */
function resolveAgentAddress(to: string, context: ToolUseContext): string | undefined {
  return context.getAppState().agentNameRegistry.get(to) ?? toAgentId(to) ?? undefined
}

/**
 * Throw unless this conversation may write to (or wait on) "main": only a
 * background agent can. Main itself is "main", and main is blocked on an
 * inline agent, which answers with its final message.
 */
function assertReachesMain(context: ToolUseContext): void {
  const { agentId } = context
  if (agentId === undefined) {
    throw new Error(
      isTeammate()
        ? `Teammates reach the lead as "${TEAM_LEAD_NAME}", not "${MAIN_ADDRESS}".`
        : `You are the main conversation — "${MAIN_ADDRESS}" addresses you.`,
    )
  }
  const appState = context.getAppState()
  const task = appState.tasks[agentId]
  if (!isLocalAgentTask(task) || isMainSessionTask(task) || !task.isBackgrounded) {
    throw new Error(
      `"${MAIN_ADDRESS}" is for background agents. An agent running inline hands its final message to the main conversation — put what you want to say there.`,
    )
  }
}

/**
 * A background agent writing to the main conversation. It lands in the main
 * thread's queue: drained into the current turn at its next tool round, or
 * starting a turn when the main conversation is idle — the same two paths a
 * task notification takes.
 */
function handleMainMessage(
  content: string,
  context: ToolUseContext,
  awaitingReply: boolean,
): { data: MessageOutput } {
  assertReachesMain(context)
  const sender = senderOf(context)
  spendAgentSend(context)
  enqueue({
    value: formatAgentMessage({ ...sender, body: content, to: MAIN_ADDRESS, awaitingReply }),
    mode: 'task-notification',
    priority: 'next',
    skipSlashCommands: true,
    origin: { kind: 'subagent', name: sender.description ?? sender.from },
  })
  return {
    data: {
      success: true,
      message: "Message queued for the main conversation's next turn.",
    },
  }
}

function isKnownTeammate(
  appState: ReturnType<ToolUseContext['getAppState']>,
  name: string,
): boolean {
  const team = appState.teamContext
  if (!team) return false
  return (
    name === TEAM_LEAD_NAME ||
    Object.values(team.teammates).some(teammate => teammate.name === name)
  )
}

function describePeerDelivery(
  label: string,
  response: ResponseFrame,
  {
    hasInbox,
    fromAgent,
    askedIdle,
  }: { hasInbox: boolean; fromAgent: boolean; askedIdle: boolean },
): string {
  const outcome =
    response.outcome === 'subscribed'
      ? `Subscribed: ${label} will send you one [Cross-session idle notice] when it next goes idle or exits — at once if it is idle now. Nothing was delivered to its Claude.`
      : response.outcome === 'held'
        ? `Delivered to ${label}, but held for its user's approval (${response.detail ?? 'that session runs in a different permission mode'}). ${hasInbox ? 'A [Cross-session delivery notice] will say when it is delivered, denied or expires.' : 'This session has no inbox, so nothing will say whether it gets through.'} Do not wait for a reply.`
        : `Delivered to ${label}: its Claude reads it at its next tool round, or starts a turn with it if the session is idle. Delivered is not read — any reply arrives here wrapped in <cross-session-message>.`
  const idle =
    askedIdle && response.outcome !== 'subscribed'
      ? response.subscribed
        ? [`One [Cross-session idle notice] will follow when ${label} next goes idle or exits.`]
        : [`No idle notice will come (${response.detail ?? 'the subscription was not taken'}).`]
      : []
  const notes = [
    ...idle,
    ...(hasInbox
      ? []
      : ['This session has no inbox (only an interactive session gets one), so a reply cannot reach it.']),
    ...(fromAgent
      ? ["It went out under this session's address: a reply reaches the main conversation, not this agent."]
      : []),
  ]
  return [outcome, ...notes].join(' ')
}

/**
 * Send to another Claudin session through its inbox. Its PID record supplies
 * the socket and the token, and the socket is only ever one some live
 * session advertises — resolvePeerTarget has already refused anything else.
 */
async function sendToPeer(
  peer: PeerSession,
  content: string | undefined,
  ownName: string,
  context: ToolUseContext,
  notifyWhenIdle: boolean,
): Promise<{ data: MessageOutput }> {
  const label = `${peer.name} [${peer.ref}]`
  if (content !== undefined && content.length > MESSAGE_MAX_CHARS) {
    throw new Error(
      `That message is ${content.length.toLocaleString('en-US')} characters; another session takes at most ${MESSAGE_MAX_CHARS.toLocaleString('en-US')}. It shares this machine's filesystem — write the content to a file and send the path.`,
    )
  }
  const own = getOwnInbox()
  if (notifyWhenIdle && !own) {
    throw new Error(
      'notify_when_idle needs an inbox for the notice to reach, and this session has none (only an interactive session gets one). Send without it.',
    )
  }
  if (!takeCrossSessionSend()) {
    throw new Error(
      `This session has sent ${CROSS_SESSION_SENDS_PER_USER_PROMPT} messages to other sessions since your user last wrote. Stop and ask your user before sending more — two sessions answering each other can loop forever.`,
    )
  }
  const appState = context.getAppState()
  const agentName =
    context.agentId === undefined
      ? undefined
      : (findAgentName(appState.agentNameRegistry, context.agentId) ??
        context.agentId)
  const msgId = randomUUID()
  // Waited on before the send: a session already idle answers a pure
  // subscription at once, and a notice nobody awaits yet is dropped.
  if (notifyWhenIdle) awaitIdleNotice(msgId, label)
  const auth = {
    v: FRAME_VERSION,
    msg_id: msgId,
    token: peer.token,
    from: own ? formatUdsAddress(own.socketPath) : undefined,
    from_name: ownName,
    from_mode: permissionClassOf(appState.toolPermissionContext.mode),
    from_plan: appState.toolPermissionContext.mode === 'plan' || undefined,
  } as const
  let response: ResponseFrame
  try {
    response = await sendFrame(
      peer.socketPath,
      content === undefined
        ? { ...auth, type: 'notify_when_idle' }
        : {
            ...auth,
            type: 'message',
            text: content,
            from_agent: agentName,
            notify_when_idle: notifyWhenIdle || undefined,
          },
    )
  } catch (e) {
    takeAwaitedIdleNotice(msgId)
    if (e instanceof PeerDeliveryError) {
      throw new Error(`Could not reach ${label}: ${e.message}.`)
    }
    throw e
  }
  if (!response.ok) {
    takeAwaitedIdleNotice(msgId)
    return {
      data: {
        success: false,
        message: `${label} did not take the message: ${response.detail ?? 'no reason given'}.`,
      },
    }
  }
  // Its outcome comes back later as a delivery_status, which is only believed
  // for a send this session is waiting on.
  if (response.outcome === 'held' && own) awaitDeliveryStatus(msgId, label)
  if (notifyWhenIdle && !response.subscribed) takeAwaitedIdleNotice(msgId)
  return {
    data: {
      success: true,
      message: describePeerDelivery(label, response, {
        hasInbox: own !== undefined,
        fromAgent: agentName !== undefined,
        askedIdle: notifyWhenIdle,
      }),
    },
  }
}

type LocatedPeer = { peer: PeerSession; selfName: string }

/**
 * The session `to` names, when it names one; undefined hands the name back to
 * the agent and teammate routes. `required` is for what only a session can
 * take: then every miss throws, with the reason.
 */
async function locatePeer(
  to: string,
  required: boolean,
): Promise<LocatedPeer | undefined> {
  const address = parseAddress(to)
  const unavailable = crossSessionUnavailableReason()
  if (unavailable) {
    if (address.scheme === 'uds' || required) throw new Error(unavailable)
    return undefined
  }
  if (address.scheme === 'uds' && address.target === getOwnInbox()?.socketPath) {
    throw new Error('That address is this session — a message to it would be a message to yourself.')
  }
  const directory = await readSessionDirectory()
  const resolution = resolvePeerTarget(to, directory.peers)
  if ('notAPeer' in resolution) {
    if (required) {
      throw new Error(
        `notify_when_idle is for another Claudin session on this machine, and no session is named "${to}" — ${LIST_AGENTS_TOOL_NAME} lists them. A background agent reports back on its own when it finishes.`,
      )
    }
    return undefined
  }
  if ('error' in resolution) throw new Error(resolution.error)
  return { peer: resolution.peer, selfName: directory.self.name }
}

/** A plain send to another session, when `to` names one. */
async function routeToPeer(
  to: string,
  content: string,
  context: ToolUseContext,
): Promise<{ data: MessageOutput } | undefined> {
  const located = await locatePeer(to, false)
  return located && sendToPeer(located.peer, content, located.selfName, context, false)
}

/** A send that asks for an idle notice, or only asks for one. */
async function subscribeToPeer(
  to: string,
  content: string | undefined,
  context: ToolUseContext,
): Promise<{ data: MessageOutput }> {
  const located = await locatePeer(to, true)
  if (!located) throw new Error(`No session named "${to}" to subscribe to.`)
  return sendToPeer(located.peer, content, located.selfName, context, true)
}

async function handleMessage(
  recipientName: string,
  content: string,
  summary: string | undefined,
  context: ToolUseContext,
): Promise<{ data: MessageOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)
  const senderName =
    getAgentName() || (isTeammate() ? 'teammate' : TEAM_LEAD_NAME)
  const senderColor = getTeammateColor()

  await writeToMailbox(
    recipientName,
    {
      from: senderName,
      text: content,
      summary,
      timestamp: new Date().toISOString(),
      color: senderColor,
    },
    teamName,
  )

  const recipientColor = findTeammateColor(appState, recipientName)

  return {
    data: {
      success: true,
      message: `Message sent to ${recipientName}'s inbox`,
      routing: {
        sender: senderName,
        senderColor,
        target: `@${recipientName}`,
        targetColor: recipientColor,
        summary,
        content,
      },
    },
  }
}

async function handleBroadcast(
  content: string,
  summary: string | undefined,
  context: ToolUseContext,
): Promise<{ data: BroadcastOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)

  if (!teamName) {
    throw new Error(
      '"*" broadcasts to an agent team, and this session is not in one.',
    )
  }

  const teamFile = await readTeamFileAsync(teamName)
  if (!teamFile) {
    throw new Error(`Team "${teamName}" does not exist`)
  }

  const senderName =
    getAgentName() || (isTeammate() ? 'teammate' : TEAM_LEAD_NAME)
  const senderColor = getTeammateColor()

  const recipients: string[] = []
  for (const member of teamFile.members) {
    if (member.name.toLowerCase() === senderName.toLowerCase()) {
      continue
    }
    recipients.push(member.name)
  }

  if (recipients.length === 0) {
    return {
      data: {
        success: true,
        message: 'No teammates to broadcast to (you are the only team member)',
        recipients: [],
      },
    }
  }

  for (const recipientName of recipients) {
    await writeToMailbox(
      recipientName,
      {
        from: senderName,
        text: content,
        summary,
        timestamp: new Date().toISOString(),
        color: senderColor,
      },
      teamName,
    )
  }

  return {
    data: {
      success: true,
      message: `Message broadcast to ${recipients.length} teammate(s): ${recipients.join(', ')}`,
      recipients,
      routing: {
        sender: senderName,
        senderColor,
        target: '@team',
        summary,
        content,
      },
    },
  }
}

async function handleShutdownRequest(
  targetName: string,
  reason: string | undefined,
  context: ToolUseContext,
): Promise<{ data: RequestOutput }> {
  const appState = context.getAppState()
  const teamName = getTeamName(appState.teamContext)
  const senderName = getAgentName() || TEAM_LEAD_NAME
  const requestId = generateRequestId('shutdown', targetName)

  const shutdownMessage = createShutdownRequestMessage({
    requestId,
    from: senderName,
    reason,
  })

  await writeToMailbox(
    targetName,
    {
      from: senderName,
      text: jsonStringify(shutdownMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Shutdown request sent to ${targetName}. Request ID: ${requestId}`,
      request_id: requestId,
      target: targetName,
    },
  }
}

/**
 * Why this conversation may not approve a shutdown, or undefined when it may.
 * Approving ends the approver — a teammate's own loop or process. Anyone else
 * (the lead, a background agent) holds no such exit, and the fallback below
 * would end the whole session instead.
 */
export function shutdownApprovalRefusal(): string | undefined {
  if (isTeammate()) return undefined
  return 'Only a teammate answers a shutdown request by exiting — you are not one, and approving would end this whole session. Tell whoever asked that you are not a teammate.'
}

async function handleShutdownApproval(
  requestId: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const refusal = shutdownApprovalRefusal()
  if (refusal) throw new Error(refusal)
  const teamName = getTeamName()
  const agentId = getAgentId()
  const agentName = getAgentName() || 'teammate'

  logForDebugging(
    `[SendMessageTool] handleShutdownApproval: teamName=${teamName}, agentId=${agentId}, agentName=${agentName}`,
  )

  let ownPaneId: string | undefined
  let ownBackendType: BackendType | undefined
  if (teamName) {
    const teamFile = await readTeamFileAsync(teamName)
    if (teamFile && agentId) {
      const selfMember = teamFile.members.find(m => m.agentId === agentId)
      if (selfMember) {
        ownPaneId = selfMember.tmuxPaneId
        ownBackendType = selfMember.backendType
      }
    }
  }

  const approvedMessage = createShutdownApprovedMessage({
    requestId,
    from: agentName,
    paneId: ownPaneId,
    backendType: ownBackendType,
  })

  await writeToMailbox(
    TEAM_LEAD_NAME,
    {
      from: agentName,
      text: jsonStringify(approvedMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  if (ownBackendType === 'in-process') {
    logForDebugging(
      `[SendMessageTool] In-process teammate ${agentName} approving shutdown - signaling abort`,
    )

    if (agentId) {
      const appState = context.getAppState()
      const task = findTeammateTaskByAgentId(agentId, appState.tasks)
      if (task?.abortController) {
        task.abortController.abort()
        logForDebugging(
          `[SendMessageTool] Aborted controller for in-process teammate ${agentName}`,
        )
      } else {
        logForDebugging(
          `[SendMessageTool] Warning: Could not find task/abortController for ${agentName}`,
        )
      }
    }
  } else {
    if (agentId) {
      const appState = context.getAppState()
      const task = findTeammateTaskByAgentId(agentId, appState.tasks)
      if (task?.abortController) {
        logForDebugging(
          `[SendMessageTool] Fallback: Found in-process task for ${agentName} via AppState, aborting`,
        )
        task.abortController.abort()

        return {
          data: {
            success: true,
            message: `Shutdown approved (fallback path). Agent ${agentName} is now exiting.`,
            request_id: requestId,
          },
        }
      }
    }

    setImmediate(async () => {
      await gracefulShutdown(0, 'other')
    })
  }

  return {
    data: {
      success: true,
      message: `Shutdown approved. Sent confirmation to team-lead. Agent ${agentName} is now exiting.`,
      request_id: requestId,
    },
  }
}

async function handleShutdownRejection(
  requestId: string,
  reason: string,
): Promise<{ data: ResponseOutput }> {
  const teamName = getTeamName()
  const agentName = getAgentName() || 'teammate'

  const rejectedMessage = createShutdownRejectedMessage({
    requestId,
    from: agentName,
    reason,
  })

  await writeToMailbox(
    TEAM_LEAD_NAME,
    {
      from: agentName,
      text: jsonStringify(rejectedMessage),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Shutdown rejected. Reason: "${reason}". Continuing to work.`,
      request_id: requestId,
    },
  }
}

async function handlePlanApproval(
  recipientName: string,
  requestId: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const appState = context.getAppState()
  const teamName = appState.teamContext?.teamName

  if (!isTeamLead(appState.teamContext)) {
    throw new Error(
      'Only the team lead can approve plans. Teammates cannot approve their own or other plans.',
    )
  }

  const leaderMode = appState.toolPermissionContext.mode
  const modeToInherit = leaderMode === 'plan' ? 'default' : leaderMode

  const approvalResponse = {
    type: 'plan_approval_response',
    requestId,
    approved: true,
    timestamp: new Date().toISOString(),
    permissionMode: modeToInherit,
  }

  await writeToMailbox(
    recipientName,
    {
      from: TEAM_LEAD_NAME,
      text: jsonStringify(approvalResponse),
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Plan approved for ${recipientName}. They will receive the approval and can proceed with implementation.`,
      request_id: requestId,
    },
  }
}

async function handlePlanRejection(
  recipientName: string,
  requestId: string,
  feedback: string,
  context: ToolUseContext,
): Promise<{ data: ResponseOutput }> {
  const appState = context.getAppState()
  const teamName = appState.teamContext?.teamName

  if (!isTeamLead(appState.teamContext)) {
    throw new Error(
      'Only the team lead can reject plans. Teammates cannot reject their own or other plans.',
    )
  }

  const rejectionResponse = {
    type: 'plan_approval_response',
    requestId,
    approved: false,
    feedback,
    timestamp: new Date().toISOString(),
  }

  await writeToMailbox(
    recipientName,
    {
      from: TEAM_LEAD_NAME,
      text: jsonStringify(rejectionResponse),
      timestamp: new Date().toISOString(),
    },
    teamName,
  )

  return {
    data: {
      success: true,
      message: `Plan rejected for ${recipientName} with feedback: "${feedback}"`,
      request_id: requestId,
    },
  }
}

/**
 * A stopped agent — or one evicted from state (`status` undefined) — resumed
 * in the background with the message: once, however many sends reach it
 * together, the later ones queued into the run the first one started.
 */
async function resumeWithLetter({
  agentId,
  to,
  letter,
  status,
  context,
  canUseTool,
}: {
  agentId: string
  to: string
  letter: string
  status?: string
  context: ToolUseContext
  canUseTool: CanUseToolFn
}): Promise<{ data: MessageOutput }> {
  // The user stopped it; another agent restarting it would undo that behind
  // the user's back. Main answers to the user, so it may.
  if (status === 'killed' && context.agentId !== undefined) {
    return {
      data: {
        success: false,
        message: `The user stopped "${to}"; only the main conversation can start it again. Put what you needed from it in your report instead.`,
      },
    }
  }
  // Its completion notice goes to main, whoever resumed it.
  const whenDone =
    context.agentId === undefined
      ? "You'll be notified when it finishes."
      : `Its completion notice goes to the main conversation — to get its answer here, call SendMessage with to: ${JSON.stringify(to)}, await_reply: true and no message.`
  try {
    const outcome = await resumeOnce(agentId, () =>
      resumeAgentBackground({ agentId, prompt: letter, toolUseContext: context, canUseTool }),
    )
    if ('joined' in outcome) {
      queuePendingMessage(agentId, letter, context.setAppStateForTasks ?? context.setAppState)
      return {
        data: {
          success: true,
          message: `Message queued for delivery to ${to} at its next tool round (another send had just resumed it).`,
        },
      }
    }
    const how =
      status === undefined
        ? 'had no active task; resumed it from its transcript'
        : `was stopped (${status}); resumed it`
    return {
      data: {
        success: true,
        message: `Agent "${to}" ${how} in the background with your message. ${whenDone} Output: ${outcome.resumed.outputFile}`,
      },
    }
  } catch (e) {
    return {
      data: {
        success: false,
        message:
          status === undefined
            ? `Agent "${to}" is registered but has no transcript to resume. It may have been cleaned up. (${errorMessage(e)})`
            : `Agent "${to}" is stopped (${status}) and could not be resumed: ${errorMessage(e)}`,
      },
    }
  }
}

/**
 * What a wait watches: an agent of this conversation (its agentId), main, or
 * another session (`peer`). Checked before anything is sent, so a send never
 * goes out on a wait that cannot happen.
 */
async function awaitTargetOf(
  to: string,
  context: ToolUseContext,
): Promise<{ agentId?: string; peer?: { name: string; label: string } }> {
  if (to === MAIN_ADDRESS) {
    assertReachesMain(context)
    return {}
  }
  const agentId = resolveAgentAddress(to, context)
  if (agentId !== undefined) return { agentId }
  const located = await locatePeer(to, false)
  if (!located) {
    throw new Error(
      `await_reply waits on an agent of this conversation, "${MAIN_ADDRESS}" or another session, and "${to}" is none of them — call ${LIST_AGENTS_TOOL_NAME} to see who you can message.`,
    )
  }
  // Another session answers this session's address, so its reply lands in
  // the main conversation — the one place a wait on it can see it.
  if (context.agentId !== undefined) {
    throw new Error(
      `A reply from another session reaches the main conversation, not this agent — send without await_reply, or ask "${MAIN_ADDRESS}" to ask.`,
    )
  }
  if (!getOwnInbox()) {
    throw new Error(
      'await_reply to another session needs an inbox for the reply to reach, and this session has none (only an interactive session gets one). Send without it.',
    )
  }
  return {
    peer: { name: located.peer.name, label: `${located.peer.name} [${located.peer.ref}]` },
  }
}

/**
 * The sends sendAndAwait makes through the tool's own call: delivered like any
 * other, but marked awaiting-reply, so the recipient knows someone is blocked.
 */
const sendsForAwait = new WeakSet<Input>()

/** Whether `text` is a message the session named `peerName` sent. */
function isReplyFrom(peerName: string, text: string): boolean {
  return parseXmlEnvelope(text, CROSS_SESSION_MESSAGE_TAG)?.attrs['from-name'] === peerName
}

/**
 * `await_reply`: send (when there is a message), then hold the call until an
 * answer arrives or the recipient stops. What arrived is returned verbatim —
 * taken out of the waiter's queue, so it is not delivered a second time.
 */
async function sendAndAwait(
  input: Input,
  context: ToolUseContext,
  send: (input: Input) => Promise<{ data: SendMessageToolOutput }>,
): Promise<{ data: MessageOutput }> {
  const target = await awaitTargetOf(input.to, context)
  let sent: SendMessageToolOutput | undefined
  let letter: string | undefined
  // A session is also subscribed to, so the wait ends when it goes idle
  // without answering — and a wait with no message is that subscription alone.
  if (typeof input.message === 'string' || target.peer) {
    const sendInput = { ...input, notify_when_idle: target.peer !== undefined }
    sendsForAwait.add(sendInput)
    sent = (await send(sendInput)).data
    if (!sent.success) return { data: { success: false, message: sent.message } }
    if (target.agentId !== undefined && typeof input.message === 'string') {
      letter = formatAgentMessage({
        ...senderOf(context),
        body: input.message,
        to: input.to,
        awaitingReply: true,
      })
    }
  }
  const outcome = await awaitReply(inSessionProbe(context, target.agentId, letter), {
    signal: context.abortController.signal,
  })
  // The idle subscription was only there to end the wait if the session went
  // quiet. It answered, so its later idle notice would be noise — a turn
  // spent reading "is idle now".
  if (target.peer && outcome.kind === 'replied' && outcome.messages.some(text => isReplyFrom(target.peer!.name, text))) {
    forgetAwaitedIdleNotices(target.peer.label)
  }
  const waited = describeAwaitOutcome(input.to, outcome, context.agentId === undefined)
  return {
    data: {
      success: true,
      message: sent ? `${sent.message} ${waited}` : waited,
      ...(outcome.kind === 'replied' && { replies: outcome.messages }),
    },
  }
}

export const SendMessageTool: Tool<InputSchema, SendMessageToolOutput> =
  buildTool({
    name: SEND_MESSAGE_TOOL_NAME,
    searchHint: 'message another agent or session, and wait for its answer',
    maxResultSizeChars: 100_000,

    userFacingName() {
      return 'SendMessage'
    },

    get inputSchema(): InputSchema {
      return inputSchemaFor({
        swarm: isAgentSwarmsEnabled(),
        crossSession: crossSessionUnavailableReason() === undefined,
      })
    },
    shouldDefer: true,

    isEnabled() {
      return (
        isAgentSwarmsEnabled() ||
        !isEnvTruthy(process.env.CLAUDIN_DISABLE_SEND_MESSAGE)
      )
    },

    isReadOnly(input) {
      return input.message === undefined || typeof input.message === 'string'
    },

    backfillObservableInput(input) {
      if ('type' in input) return
      if (typeof input.to !== 'string') return

      if (input.to === '*') {
        input.type = 'broadcast'
        if (typeof input.message === 'string') input.content = input.message
      } else if (typeof input.message === 'string') {
        input.type = 'message'
        input.recipient = input.to
        input.content = input.message
      } else if (typeof input.message === 'object' && input.message !== null) {
        const msg = input.message as {
          type?: string
          request_id?: string
          approve?: boolean
          reason?: string
          feedback?: string
        }
        input.type = msg.type
        input.recipient = input.to
        if (msg.request_id !== undefined) input.request_id = msg.request_id
        if (msg.approve !== undefined) input.approve = msg.approve
        const content = msg.reason ?? msg.feedback
        if (content !== undefined) input.content = content
      }
    },

    toAutoClassifierInput(input) {
      if (input.message === undefined) {
        return input.await_reply ? `await_reply ${input.to}` : `notify_when_idle ${input.to}`
      }
      if (typeof input.message === 'string') {
        return `to ${input.to}${input.notify_when_idle ? ' (notify_when_idle)' : ''}: ${input.message}`
      }
      switch (input.message.type) {
        case 'shutdown_request':
          return `shutdown_request to ${input.to}`
        case 'shutdown_response':
          return `shutdown_response ${input.message.approve ? 'approve' : 'reject'} ${input.message.request_id}`
        case 'plan_approval_response':
          return `plan_approval ${input.message.approve ? 'approve' : 'reject'} to ${input.to}`
      }
    },

    async checkPermissions(input, _context) {
      return { behavior: 'allow' as const, updatedInput: input }
    },

    async validateInput(input, context) {
      if (input.to.trim().length === 0) {
        return {
          result: false,
          message: 'to must not be empty',
          errorCode: 9,
        }
      }
      if (!SINGLE_LINE_RE.test(input.to) || input.to.length > TO_MAX_CHARS) {
        return {
          result: false,
          message: `to must be a single-line name or address of at most ${TO_MAX_CHARS} characters`,
          errorCode: 9,
        }
      }
      const addr = parseAddress(input.to)
      if (
        (addr.scheme === 'bridge' || addr.scheme === 'uds') &&
        addr.target.trim().length === 0
      ) {
        return {
          result: false,
          message: 'address target must not be empty',
          errorCode: 9,
        }
      }
      if (addr.scheme === 'bridge') {
        return {
          result: false,
          message:
            'Remote Control sessions cannot be messaged from Claudin — only sessions on this machine, by the name ListAgents prints',
          errorCode: 9,
        }
      }
      if (input.to.includes('@')) {
        return {
          result: false,
          message:
            'to must be a bare name, "main" or an agentId — "@" is not part of any address',
          errorCode: 9,
        }
      }
      const swarm = isAgentSwarmsEnabled()
      if (input.await_reply) {
        if (input.notify_when_idle) {
          return {
            result: false,
            message: 'await_reply already waits for the answer — leave out notify_when_idle',
            errorCode: 9,
          }
        }
        if (input.to === '*') {
          return {
            result: false,
            message: 'await_reply waits on one recipient, not a broadcast',
            errorCode: 9,
          }
        }
        if (input.message !== undefined && typeof input.message !== 'string') {
          return {
            result: false,
            message: 'await_reply rides on a plain-text message, or on none — not on a structured one',
            errorCode: 9,
          }
        }
      }
      if (
        context.agentId !== undefined &&
        (input.to === context.agentId ||
          context.getAppState().agentNameRegistry.get(input.to) === context.agentId)
      ) {
        return {
          result: false,
          message: `"${input.to}" is you — a message to yourself reaches no one`,
          errorCode: 9,
        }
      }
      if (input.notify_when_idle) {
        if (input.message !== undefined && typeof input.message !== 'string') {
          return {
            result: false,
            message: 'notify_when_idle rides on a plain-text message, or on none — not on a structured one',
            errorCode: 9,
          }
        }
        if (input.to === '*' || input.to === MAIN_ADDRESS) {
          return {
            result: false,
            message: `notify_when_idle is for another session on this machine, not "${input.to}"`,
            errorCode: 9,
          }
        }
        // The notice lands in the session's main conversation, which did not
        // ask for it; the agent that did would never see it.
        if (context.agentId !== undefined) {
          return {
            result: false,
            message:
              'notify_when_idle is for the main conversation — the notice would arrive there, not here. Send without it.',
            errorCode: 9,
          }
        }
      }
      if (input.message === undefined) {
        return input.notify_when_idle || input.await_reply
          ? { result: true }
          : {
              result: false,
              message:
                'message is required — leave it out only to wait (await_reply) or for a pure notify_when_idle subscription',
              errorCode: 9,
            }
      }
      if (typeof input.message === 'string') {
        if (input.to === '*' && !swarm) {
          return {
            result: false,
            message:
              '"*" broadcasts to an agent team, and this session is not in one',
            errorCode: 9,
          }
        }
        if (input.message.trim().length === 0) {
          return {
            result: false,
            message: 'message must not be empty',
            errorCode: 9,
          }
        }
        return { result: true }
      }

      if (!swarm) {
        return {
          result: false,
          message:
            'structured messages belong to the agent-team protocol — send plain text',
          errorCode: 9,
        }
      }

      if (input.to === '*') {
        return {
          result: false,
          message: 'structured messages cannot be broadcast (to: "*")',
          errorCode: 9,
        }
      }

      if (
        input.message.type === 'shutdown_response' &&
        input.to !== TEAM_LEAD_NAME
      ) {
        return {
          result: false,
          message: `shutdown_response must be sent to "${TEAM_LEAD_NAME}"`,
          errorCode: 9,
        }
      }

      if (
        input.message.type === 'shutdown_response' &&
        !input.message.approve &&
        (!input.message.reason || input.message.reason.trim().length === 0)
      ) {
        return {
          result: false,
          message: 'reason is required when rejecting a shutdown request',
          errorCode: 9,
        }
      }

      return { result: true }
    },

    async description() {
      return DESCRIPTION
    },

    async prompt() {
      return getPrompt({
        swarm: isAgentSwarmsEnabled(),
        crossSession: crossSessionUnavailableReason() === undefined,
      })
    },

    mapToolResultToToolResultBlockParam(data, toolUseID) {
      // What an await_reply brought back reads as the messages themselves,
      // not as JSON-escaped strings.
      if ('replies' in data && data.replies && data.replies.length > 0) {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result' as const,
          content: [
            {
              type: 'text' as const,
              text: `${data.message}\n\n${data.replies.join('\n\n')}`,
            },
          ],
        }
      }
      return {
        tool_use_id: toolUseID,
        type: 'tool_result' as const,
        content: [
          {
            type: 'text' as const,
            text: jsonStringify(data),
          },
        ],
      }
    },

    async call(input, context, canUseTool, parentMessage) {
      if (input.await_reply && !sendsForAwait.has(input)) {
        return sendAndAwait(input, context, sendInput =>
          SendMessageTool.call(sendInput, context, canUseTool, parentMessage),
        )
      }
      if (input.notify_when_idle || input.message === undefined) {
        return subscribeToPeer(
          input.to,
          typeof input.message === 'string' ? input.message : undefined,
          context,
        )
      }
      if (typeof input.message === 'string' && input.to === MAIN_ADDRESS) {
        return handleMainMessage(input.message, context, input.await_reply === true)
      }

      // Route to in-process subagent by name or raw agentId before falling
      // through to ambient-team resolution. Stopped agents are auto-resumed.
      if (typeof input.message === 'string' && input.to !== '*') {
        const appState = context.getAppState()
        const agentId = resolveAgentAddress(input.to, context)
        if (agentId) {
          const task = appState.tasks[agentId]
          spendAgentSend(context)
          // Delivered in the envelope on every path, so the agent learns who
          // wrote and where to answer, and its classifier sees agent text.
          const letter = formatAgentMessage({
            ...senderOf(context),
            body: input.message,
            to: input.to,
            awaitingReply: input.await_reply === true,
          })
          if (isLocalAgentTask(task) && !isMainSessionTask(task)) {
            if (task.status === 'running') {
              queuePendingMessage(
                agentId,
                letter,
                context.setAppStateForTasks ?? context.setAppState,
              )
              return {
                data: {
                  success: true,
                  message: `Message queued for delivery to ${input.to} at its next tool round.`,
                },
              }
            }
            return resumeWithLetter({
              agentId,
              to: input.to,
              letter,
              status: task.status,
              context,
              canUseTool,
            })
          }
          // Evicted from state: resume from its transcript on disk. agentId is a
          // registered name or a format-matching raw id (toAgentId validates the
          // createAgentId format, so teammate names never reach this).
          return resumeWithLetter({ agentId, to: input.to, letter, context, canUseTool })
        }
      }

      if (typeof input.message === 'string') {
        const summary = resolveSummary(input.summary, input.message)
        if (input.to === '*') {
          return handleBroadcast(input.message, summary, context)
        }
        const swarm = isAgentSwarmsEnabled()
        if (swarm && isKnownTeammate(context.getAppState(), input.to)) {
          return handleMessage(input.to, input.message, summary, context)
        }
        const peerResult = await routeToPeer(input.to, input.message, context)
        if (peerResult) return peerResult
        // A teammate send writes to a mailbox that only an agent team reads,
        // so outside one an unknown name must fail here — reporting success
        // would drop the message on the floor. Agent teams switched on is not
        // a team: until this session joins one, nothing polls that mailbox.
        if (!swarm || !getTeamName(context.getAppState().teamContext)) {
          throw new Error(
            `No agent or session named "${input.to}" — call ${LIST_AGENTS_TOOL_NAME} to see who you can message, and copy a name exactly as it prints.`,
          )
        }
        return handleMessage(input.to, input.message, summary, context)
      }

      if (input.to === '*') {
        throw new Error('structured messages cannot be broadcast')
      }

      switch (input.message.type) {
        case 'shutdown_request':
          return handleShutdownRequest(input.to, input.message.reason, context)
        case 'shutdown_response':
          if (input.message.approve) {
            return handleShutdownApproval(input.message.request_id, context)
          }
          return handleShutdownRejection(
            input.message.request_id,
            input.message.reason!,
          )
        case 'plan_approval_response':
          if (input.message.approve) {
            return handlePlanApproval(
              input.to,
              input.message.request_id,
              context,
            )
          }
          return handlePlanRejection(
            input.to,
            input.message.request_id,
            input.message.feedback ?? 'Plan needs revision',
            context,
          )
      }
    },

    renderToolUseMessage,
    renderToolResultMessage,
  } satisfies ToolDef<InputSchema, SendMessageToolOutput>)
