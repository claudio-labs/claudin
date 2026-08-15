import { describe, expect, test } from 'bun:test'
import { claimsAgentLaunch } from 'src/shared/proc/phantomLaunchGuard.js'

describe('claimsAgentLaunch — positives (agent launch announcements)', () => {
  const positives = [
    // EN — agent noun adjacent to a launch cue
    '2 agents launched in parallel in the background. I’ll report back when they finish.',
    'Dispatched the review agent in the background.',
    'Kicked off both agents in parallel — I’ll let you know once they return.',
    '3 agents now running in parallel.',
    'Launching the explore agent now.',
    "I've delegated this to a subagent.",
    'Spinning up two agents to handle this.',
    'Both agents are off and running.',
    // PT-BR — exactly the phrasings seen in the wild (screenshots)
    'Agente Code disparado em background. Aviso quando voltar.',
    '2 agentes Code disparados em paralelo (background). Aviso quando os 2 voltarem.',
    'Lancei os dois agentes em paralelo.',
    'Agentes rodando em background, te aviso quando terminarem.',
    'Disparei o agente de review em segundo plano.',
    'Deleguei isso pra um subagente.',
    // PT "no" (= em+o) must not break the match nor be read as EN "no"
    'Disparei o agente no background, aviso quando voltar.',
    // Negation in an UNRELATED clause must NOT silence a real phantom launch
    "I'm not going to wait — launched 2 agents in the background.",
    'Spinning up two agents without blocking your work.',
    'Kicked off the agents; none of this should block you.',
    "Launched the agents. Done — I'll report back.",
    'Dispatched 2 agents in parallel; results are not in yet.',
    'Disparei os agentes; não vou te incomodar até terminarem.',
    'Lancei 2 agentes em paralelo, sem bloquear seu trabalho.',
  ]
  for (const text of positives) {
    test(text.slice(0, 52), () => {
      expect(claimsAgentLaunch(text)).toBe(true)
    })
  }
})

describe('claimsAgentLaunch — false-positive guards (must NOT fire)', () => {
  const negatives = [
    // The dominant false-positive class: launch cues with NO agent noun
    // (builds, servers, test suites, requests, pipelines, downloads).
    'The tests are running in parallel across 4 workers.',
    'I started the dev server in the background; it’s on port 3000.',
    'The build is now running in the background.',
    'I kicked off the CI pipeline in the background.',
    'The download started in the background.',
    'I dispatched the request in the background to keep the UI responsive.',
    'Os testes estão rodando em paralelo.',
    'Iniciei o servidor em background na porta 3000.',
    'O build está rodando em segundo plano.',
    'I’ll let you know once the build finishes.',
    'I will report back when CI is green.',
    // Explanatory / instructional — talking about launching agents, not doing it
    'When you launch an agent in the background, it runs in parallel and reports back.',
    'You can dispatch agents in parallel to speed things up.',
    'To launch an agent in the background, pass run_in_background: true.',
    'Quando você dispara um agente em background, ele roda em paralelo.',
    'Para disparar agentes em paralelo, use uma única mensagem com várias chamadas.',
    'Como disparar um agente em segundo plano: passe run_in_background.',
    // Negation — the model DECLINED to launch (must not warn)
    'No agents were launched — the task was simple enough to do inline.',
    "I didn't dispatch any agents for this; handled it directly.",
    "This agent doesn't run in parallel.",
    'Nenhum agente foi disparado, resolvi direto.',
    'Não vou disparar agentes pra isso.',
    // Completion / past-tense recap of a prior agent (the common benign flow)
    'The agent finished and is no longer running in the background.',
    'The subagent completed; it was running in parallel earlier.',
    'Both agents returned — here is the combined summary.',
    'O agente terminou, não está mais rodando em background.',
    'Os dois agentes voltaram com os resultados.',
    // Terminal / error state, not a launch
    'The agent crashed while a build was running in the background.',
    // Negation directly governing the launch — the model declined (must suppress)
    'Without launching any agents, I fixed it inline.',
    'I never dispatched the agents — handled it myself.',
    'Não disparei agentes, resolvi na mão.',
    // Ordinary prose, incl. agent-word with no launch semantics
    'I read the file and found the bug on line 42.',
    'The agent description mentions it should be used proactively.',
    'O build passou e os testes estão verdes.',
    '',
    '   ',
  ]
  for (const text of negatives) {
    test(text.slice(0, 52) || '(empty)', () => {
      expect(claimsAgentLaunch(text)).toBe(false)
    })
  }
})
