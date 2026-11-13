import { ready, server } from '@serenity-kit/opaque'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { demo } from './config'

let setup: Promise<string> | undefined

export function opaqueSetup() {
  return (setup ??= loadSetup())
}

async function loadSetup() {
  await ready
  let value = process.env.OPAQUE_SERVER_KEY
  if (!value && process.env.OPAQUE_SERVER_KEY_FILE)
    value = (await readFile(process.env.OPAQUE_SERVER_KEY_FILE, 'utf8')).trim()
  if (!value) {
    if (!demo)
      throw new Error('OPAQUE_SERVER_KEY or OPAQUE_SERVER_KEY_FILE is required in live mode')
    const file = resolve('.data/opaque.key')
    await mkdir(resolve('.data'), { recursive: true, mode: 0o700 })
    try {
      await writeFile(file, server.createSetup(), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    value = (await readFile(file, 'utf8')).trim()
  }
  // Fail at startup, without logging key material, if the persisted setup is invalid.
  try {
    server.getPublicKey(value)
  } catch {
    throw new Error('Invalid OPAQUE server setup')
  }
  return value
}
