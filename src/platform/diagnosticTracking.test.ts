import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { DiagnosticTrackingService } from 'src/platform/diagnosticTracking.js'
import type { MCPServerConnection } from 'src/services/mcp/types.js'

// Mock the IDE client utility
const mockGetConnectedIdeClient = (clients: MCPServerConnection[]) => 
  clients.find(client => client.type === 'connected')

describe('DiagnosticTrackingService', () => {
  let service: DiagnosticTrackingService
  let mockClients: MCPServerConnection[]
  let mockIdeClient: MCPServerConnection

  beforeEach(() => {
    // Get fresh instance for each test
    service = DiagnosticTrackingService.getInstance()
    
    // Setup mock clients
    mockIdeClient = {
      type: 'connected',
      name: 'test-ide',
      capabilities: {},
      config: {},
      cleanup: async () => {},
      client: {
        request: async () => ({}),
        setNotificationHandler: () => {},
        close: async () => {},
      },
    } as unknown as MCPServerConnection

    mockClients = [
      { type: 'disconnected', name: 'test-disconnected', config: {} } as unknown as MCPServerConnection,
      mockIdeClient,
    ]
  })

  afterEach(async () => {
    await service.shutdown()
  })

  describe('handleQueryStart', () => {
    test('should store MCP clients and initialize service', async () => {
      await service.handleQueryStart(mockClients)

      // Service should be initialized
      expect(service).toBeDefined()

      // Should be able to get IDE client from stored clients
      // We can't directly test private methods, but we can test the behavior
      const result = await service.getNewDiagnosticsCompat()
      expect(result).toEqual([]) // Should return empty when no diagnostics
    })

    test('should reset service if already initialized', async () => {
      // Initialize first
      await service.handleQueryStart(mockClients)
      
      // Call again - should reset without error
      await service.handleQueryStart(mockClients)
      
      // Should still work
      const result = await service.getNewDiagnosticsCompat()
      expect(result).toEqual([])
    })
  })

  describe('backward-compatible methods', () => {
    beforeEach(async () => {
      await service.handleQueryStart(mockClients)
    })

    test('beforeFileEditedCompat should work without explicit client', async () => {
      // Should not throw error and should return undefined when no IDE client
      const result = await service.beforeFileEditedCompat('/test/file.ts')
      expect(result).toBeUndefined()
    })

    test('getNewDiagnosticsCompat should work without explicit client', async () => {
      const result = await service.getNewDiagnosticsCompat()
      expect(Array.isArray(result)).toBe(true)
    })

    test('ensureFileOpenedCompat should work without explicit client', async () => {
      const result = await service.ensureFileOpenedCompat('/test/file.ts')
      expect(result).toBeUndefined()
    })
  })

  describe('new explicit client methods', () => {
    test('beforeFileEdited should require client parameter', async () => {
      // Should not work without client
      const result = await service.beforeFileEdited('/test/file.ts', undefined as any)
      expect(result).toBeUndefined()
    })

    test('getNewDiagnostics should require client parameter', async () => {
      // Should not work without client
      const result = await service.getNewDiagnostics(undefined as any)
      expect(result).toEqual([])
    })

    test('ensureFileOpened should require client parameter', async () => {
      // Should not work without client
      const result = await service.ensureFileOpened('/test/file.ts', undefined as any)
      expect(result).toBeUndefined()
    })
  })

  describe('shutdown', () => {
    test('should clear stored clients on shutdown', async () => {
      await service.handleQueryStart(mockClients)
      
      // Verify service is working
      const beforeResult = await service.getNewDiagnosticsCompat()
      expect(Array.isArray(beforeResult)).toBe(true)
      
      // Shutdown
      await service.shutdown()
      
      // After shutdown, compat methods should return empty results
      const afterResult = await service.getNewDiagnosticsCompat()
      expect(afterResult).toEqual([])
    })
  })

  describe('integration with existing functionality', () => {
    test('should maintain existing diagnostic tracking behavior', async () => {
      await service.handleQueryStart(mockClients)
      
      // Test baseline tracking
      await service.beforeFileEditedCompat('/test/file.ts')
      
      // Test getting new diagnostics (should be empty since no IDE client is actually connected)
      const newDiagnostics = await service.getNewDiagnosticsCompat()
      expect(Array.isArray(newDiagnostics)).toBe(true)
    })

    test('should handle missing IDE client gracefully', async () => {
      // Test with no connected clients
      const noIdeClients = [
        { type: 'disconnected', name: 'test-disconnected-2', config: {} } as unknown as MCPServerConnection,
      ]

      await service.handleQueryStart(noIdeClients)

      // Should handle gracefully
      const result = await service.getNewDiagnosticsCompat()
      expect(result).toEqual([])
    })
  })

  describe('formatDiagnosticsSummary — severity sort + honest truncation', () => {
    const mkDiag = (
      severity: 'Error' | 'Warning' | 'Info' | 'Hint',
      msg: string,
      line = 1,
    ) => ({
      severity,
      message: msg,
      range: {
        start: { line, character: 0 },
        end: { line, character: 10 },
      },
    })

    test('errors come before warnings/info/hints in the output', () => {
      const out = DiagnosticTrackingService.formatDiagnosticsSummary([
        {
          uri: 'file:///a.ts',
          diagnostics: [
            mkDiag('Hint', 'h1'),
            mkDiag('Warning', 'w1'),
            mkDiag('Error', 'e1'),
            mkDiag('Info', 'i1'),
          ],
        },
      ])
      const errIdx = out.indexOf('e1')
      const warnIdx = out.indexOf('w1')
      const infoIdx = out.indexOf('i1')
      const hintIdx = out.indexOf('h1')
      expect(errIdx).toBeGreaterThanOrEqual(0)
      expect(errIdx).toBeLessThan(warnIdx)
      expect(warnIdx).toBeLessThan(infoIdx)
      expect(infoIdx).toBeLessThan(hintIdx)
    })

    test('files with errors are listed before files with only warnings', () => {
      const out = DiagnosticTrackingService.formatDiagnosticsSummary([
        {
          uri: 'file:///a.ts',
          diagnostics: [mkDiag('Warning', 'only-warning')],
        },
        {
          uri: 'file:///b.ts',
          diagnostics: [mkDiag('Error', 'has-error')],
        },
      ])
      expect(out.indexOf('has-error')).toBeLessThan(out.indexOf('only-warning'))
    })

    test('truncation footer reports honest hidden severity counts', () => {
      // Force truncation: pile in many large-message diagnostics.
      const big = 'x'.repeat(200)
      const files = Array.from({ length: 30 }, (_, i) => ({
        uri: `file:///f${i}.ts`,
        diagnostics: [
          mkDiag('Hint', `H-${i}-${big}`),
          mkDiag('Hint', `H2-${i}-${big}`),
        ],
      }))
      // Inject 3 error diagnostics so the footer can name them.
      files[0]!.diagnostics.unshift(mkDiag('Error', `E-priority-${big}`))
      files[1]!.diagnostics.unshift(mkDiag('Error', `E-priority-2-${big}`))
      files[2]!.diagnostics.unshift(mkDiag('Error', `E-priority-3-${big}`))

      const out = DiagnosticTrackingService.formatDiagnosticsSummary(files)
      expect(out).toContain('…[truncated:')
      // All 3 errors must fit (sorted first, small in count).
      expect(out).toContain('E-priority-')
      // The footer must call out hint counts since hints are what got cut.
      expect(out).toContain('hints hidden')
    })

    test('output stays under the 4000-char cap', () => {
      const big = 'y'.repeat(200)
      const files = Array.from({ length: 50 }, (_, i) => ({
        uri: `file:///f${i}.ts`,
        diagnostics: [
          mkDiag('Warning', `W-${i}-${big}`),
          mkDiag('Hint', `H-${i}-${big}`),
        ],
      }))
      const out = DiagnosticTrackingService.formatDiagnosticsSummary(files)
      // Cap is 4000 chars (UTF-8 glyphs may slightly inflate bytes).
      expect(out.length).toBeLessThanOrEqual(4000)
    })

    test('no truncation footer when under cap', () => {
      const out = DiagnosticTrackingService.formatDiagnosticsSummary([
        { uri: 'file:///a.ts', diagnostics: [mkDiag('Error', 'small')] },
      ])
      expect(out).not.toContain('…[truncated')
      expect(out).toContain('small')
    })

    test('files with empty diagnostics arrays are dropped (no orphan filename:)', () => {
      const out = DiagnosticTrackingService.formatDiagnosticsSummary([
        { uri: 'file:///a.ts', diagnostics: [] },
        { uri: 'file:///b.ts', diagnostics: [mkDiag('Error', 'real-diag')] },
        { uri: 'file:///c.ts', diagnostics: [] },
      ])
      // The sole rendered file is b.ts; a.ts and c.ts must not appear at all.
      expect(out).not.toContain('a.ts')
      expect(out).not.toContain('c.ts')
      expect(out).toContain('b.ts')
      expect(out).toContain('real-diag')
    })

    test('all-empty input renders as empty string, not orphan colons', () => {
      const out = DiagnosticTrackingService.formatDiagnosticsSummary([
        { uri: 'file:///a.ts', diagnostics: [] },
        { uri: 'file:///b.ts', diagnostics: [] },
      ])
      expect(out).toBe('')
    })
  })
})
