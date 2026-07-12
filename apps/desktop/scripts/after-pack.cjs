const fs = require('node:fs')
const path = require('node:path')

/**
 * electron-builder strips node_modules from extraResources (and pnpm 10+ won't
 * bundle transitive platform binaries), so copy the staged server (dist/ +
 * node_modules incl. node-pty's native pty.node) and the standalone Node into
 * the packaged app here, with plain fs and full fidelity.
 */
module.exports = async function afterPack(context) {
  const pkgRoot = path.resolve(__dirname, '..')
  const appName = context.packager.appInfo.productFilename
  const resources = path.join(context.appOutDir, `${appName}.app`, 'Contents', 'Resources')

  for (const name of ['server', 'node']) {
    const dest = path.join(resources, name)
    fs.rmSync(dest, { recursive: true, force: true })
    fs.cpSync(path.join(pkgRoot, 'staging', name), dest, { recursive: true, dereference: true })
  }
  fs.chmodSync(path.join(resources, 'node', 'node'), 0o755)
  return Promise.resolve()
}
