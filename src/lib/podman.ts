import Docker from 'dockerode'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

function getSocketPath(): string | undefined {
  if (process.platform === 'darwin') return undefined // podman-mac-helper symlinks to /var/run/docker.sock
  const uid = process.getuid?.()
  return `/run/user/${uid}/podman/podman.sock`
}

const socketPath = getSocketPath()
export const podman = socketPath ? new Docker({ socketPath }) : new Docker()

export async function ensureContainerRuntime(): Promise<void> {
  if (process.platform === 'darwin') {
    await ensurePodmanMachine()
  } else {
    await ensurePodmanLinux()
  }
}

async function ensurePodmanMachine(): Promise<void> {
  let stdout: string
  try {
    const result = await execFileAsync('podman', ['machine', 'list', '--format', 'json'])
    stdout = result.stdout
  } catch {
    console.error(
      '\nPodman is not installed. Install it with:\n\n'
      + '  brew install podman\n'
      + '  sudo /opt/homebrew/Cellar/podman/$(podman --version | cut -d" " -f3)/bin/podman-mac-helper install\n'
      + '  podman machine init\n'
      + '  podman machine start\n',
    )
    process.exit(1)
  }

  const machines = JSON.parse(stdout) as Array<{ Running: boolean }>
  const running = machines.some((m) => m.Running)
  if (!running) {
    console.error(
      '\nPodman machine is not running. Start it with:\n\n'
      + '  podman machine start\n'
      + '\nIf you haven\'t initialized a machine yet:\n\n'
      + '  sudo /opt/homebrew/Cellar/podman/$(podman --version | cut -d" " -f3)/bin/podman-mac-helper install\n'
      + '  podman machine init\n'
      + '  podman machine start\n',
    )
    process.exit(1)
  }
}

async function ensurePodmanLinux(): Promise<void> {
  try {
    await execFileAsync('podman', ['info', '--format', 'json'])
  } catch {
    console.error(
      '\nPodman is not installed or not running. Install it with your package manager:\n\n'
      + '  sudo apt install podman    # Debian/Ubuntu\n'
      + '  sudo dnf install podman    # Fedora/RHEL\n',
    )
    process.exit(1)
  }
}
