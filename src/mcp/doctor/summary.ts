import type { McpDoctorFinding, McpDoctorReport, McpDoctorServerReport } from 'src/mcp/doctor.js'

function isHealthy(server: McpDoctorServerReport): boolean {
  return server.liveCheck.result === 'connected' && !server.findings.some(f => f.severity !== 'info')
}

export function summarize(
  globalFindings: McpDoctorFinding[],
  servers: McpDoctorServerReport[],
): McpDoctorReport['summary'] {
  const all = [...globalFindings, ...servers.flatMap(s => s.findings)]
  return {
    totalReports: servers.length,
    healthy: servers.filter(isHealthy).length,
    warnings: all.filter(f => f.severity === 'warn').length,
    blocking: all.filter(f => f.blocking).length,
  }
}

