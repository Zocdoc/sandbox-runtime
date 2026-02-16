import { describe, it, expect } from 'bun:test'
import { spawnSync, spawn, type ChildProcess } from 'node:child_process'
import { getPlatform } from '../../src/utils/platform.js'
import { wrapCommandWithSandboxMacOS } from '../../src/sandbox/macos-sandbox-utils.js'

function skipIfNotMacOS(): boolean {
  return getPlatform() !== 'macos'
}

function runInSandbox(
  pythonCode: string,
  allowLocalBinding: boolean,
): ReturnType<typeof spawnSync> {
  const command = `python3 -c "${pythonCode}"`
  const wrappedCommand = wrapCommandWithSandboxMacOS({
    command,
    needsNetworkRestriction: true,
    allowLocalBinding,
    readConfig: undefined,
    writeConfig: undefined,
  })

  return spawnSync(wrappedCommand, {
    shell: true,
    encoding: 'utf8',
    timeout: 10000,
  })
}

// Python one-liners for socket bind tests
// AF_INET bind
const bindIPv4 = (addr: string) =>
  `import socket; s = socket.socket(socket.AF_INET, socket.SOCK_STREAM); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind(('${addr}', 0)); print('BOUND'); s.close()`

// AF_INET6 dual-stack bind (IPV6_V6ONLY=0, same as Java ServerSocketChannel.open())
const bindIPv6DualStack = (addr: string) =>
  `import socket; s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0); s.bind(('${addr}', 0)); print('BOUND'); s.close()`

// Helper to start a listener and return the port and process
function startListener(
  addr: string,
  ipv6 = false,
): Promise<{ port: number; process: ChildProcess }> {
  const listenerCode = `
import socket
import sys
s = socket.socket(socket.AF_INET${ipv6 ? '6' : ''}, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(('${addr}', 0))
s.listen(1)
port = s.getsockname()[1]
print(f'LISTENING:{port}', flush=True)
sys.stdout.flush()
conn, addr = s.accept()
conn.close()
s.close()
`.trim()

  const proc = spawn('python3', ['-c', listenerCode])

  // Wait for the listener to print the port
  let output = ''
  return new Promise<{ port: number; process: ChildProcess }>(
    (resolve, reject) => {
      const timeout = setTimeout(() => {
        proc.kill()
        reject(new Error(`Listener timeout - output: ${output}`))
      }, 5000)

      proc.stdout?.on('data', data => {
        output += data.toString()
        const match = output.match(/LISTENING:(\d+)/)
        if (match) {
          clearTimeout(timeout)
          resolve({
            port: parseInt(match[1], 10),
            process: proc,
          })
        }
      })

      proc.stderr?.on('data', data => {
        output += data.toString()
      })

      proc.on('error', error => {
        clearTimeout(timeout)
        reject(error)
      })
    },
  )
}

// Helper to run a test with a listener
async function withListener(
  addr: string,
  ipv6: boolean,
  fn: (port: number) => void,
): Promise<void> {
  const { port, process: listener } = await startListener(addr, ipv6)
  try {
    fn(port)
  } finally {
    listener.kill()
  }
}

// Python one-liners for socket connect tests
const connectIPv4 = (addr: string, port: number) =>
  `import socket; s = socket.socket(socket.AF_INET, socket.SOCK_STREAM); s.connect(('${addr}', ${port})); print('CONNECTED'); s.close()`

const connectIPv6 = (addr: string, port: number) =>
  `import socket; s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM); s.connect(('${addr}', ${port})); print('CONNECTED'); s.close()`

const connectIPv6DualStack = (addr: string, port: number) =>
  `import socket; s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM); s.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0); s.connect(('${addr}', ${port})); print('CONNECTED'); s.close()`

describe('macOS Seatbelt allowLocalBinding', () => {
  describe('when allowLocalBinding is true', () => {
    it('should allow AF_INET bind to 127.0.0.1', () => {
      if (skipIfNotMacOS()) return

      const result = runInSandbox(bindIPv4('127.0.0.1'), true)

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('BOUND')
    })

    it('should allow AF_INET6 dual-stack bind to ::ffff:127.0.0.1', () => {
      if (skipIfNotMacOS()) return

      // This is the case that breaks Java/Gradle: an IPv6 dual-stack socket
      // binding to 127.0.0.1, which the kernel represents as ::ffff:127.0.0.1
      const result = runInSandbox(bindIPv6DualStack('::ffff:127.0.0.1'), true)

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('BOUND')
    })

    it('should allow AF_INET6 bind to ::1', () => {
      if (skipIfNotMacOS()) return

      const result = runInSandbox(bindIPv6DualStack('::1'), true)

      expect(result.status).toBe(0)
      expect(result.stdout).toContain('BOUND')
    })

    it('should block outbound connections to non-loopback IPs', () => {
      if (skipIfNotMacOS()) return

      // Try to connect to 8.8.8.8:53 (Google DNS)
      // The sandbox should deny the syscall with a permission error before any packet leaves
      const result = runInSandbox(connectIPv4('8.8.8.8', 53), true)

      if (result.status === 0) {
        throw new Error(
          `Expected connection to public IP 8.8.8.8:53 to be blocked, but it succeeded.\n` +
            `This is a security vulnerability - data exfiltration is possible.\n` +
            `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
        )
      }
      expect(result.stdout).not.toContain('CONNECTED')
    })

    it('should allow outbound connections to 127.0.0.1', async () => {
      if (skipIfNotMacOS()) return

      await withListener('127.0.0.1', false, port => {
        const result = runInSandbox(connectIPv4('127.0.0.1', port), true)

        if (result.status !== 0) {
          throw new Error(
            `Expected connection to 127.0.0.1:${port} to succeed, but it was blocked.\n` +
              `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
          )
        }
        expect(result.stdout).toContain('CONNECTED')
      })
    })

    it('should allow outbound connections to ::1', async () => {
      if (skipIfNotMacOS()) return

      await withListener('::1', true, port => {
        const result = runInSandbox(connectIPv6('::1', port), true)

        if (result.status !== 0) {
          throw new Error(
            `Expected connection to [::1]:${port} to succeed, but it was blocked.\n` +
              `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
          )
        }
        expect(result.stdout).toContain('CONNECTED')
      })
    })

    it.skip('should allow outbound connections to ::ffff:127.0.0.1', async () => {
      if (skipIfNotMacOS()) return

      await withListener('127.0.0.1', false, port => {
        const result = runInSandbox(
          connectIPv6DualStack('::ffff:127.0.0.1', port),
          true,
        )

        if (result.status !== 0) {
          throw new Error(
            `Expected connection to [::ffff:127.0.0.1]:${port} to succeed, but it was blocked.\n` +
              `This is an IPv4-mapped IPv6 address that should be treated as localhost.\n` +
              `stdout: ${result.stdout}\nstderr: ${result.stderr}`,
          )
        }
        expect(result.stdout).toContain('CONNECTED')
      })
    })
  })

  describe('when allowLocalBinding is false', () => {
    it('should block AF_INET bind to 127.0.0.1', () => {
      if (skipIfNotMacOS()) return

      const result = runInSandbox(bindIPv4('127.0.0.1'), false)

      expect(result.status).not.toBe(0)
    })

    it('should block AF_INET6 dual-stack bind to ::ffff:127.0.0.1', () => {
      if (skipIfNotMacOS()) return

      const result = runInSandbox(bindIPv6DualStack('::ffff:127.0.0.1'), false)

      expect(result.status).not.toBe(0)
    })
  })
})
