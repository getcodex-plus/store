import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { demo, requireSetting } from './config'
export const id = (prefix = '') => prefix + randomBytes(16).toString('hex')
export const hash = (value: string) => createHash('sha256').update(value).digest('hex')
function key() {
  if (demo && !process.env.ENCRYPTION_KEY) {
    const directory = resolve(process.cwd(), '.data')
    const file = resolve(directory, 'encryption.key')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    try {
      writeFileSync(file, randomBytes(32), { flag: 'wx', mode: 0o600 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
    const localKey = readFileSync(file)
    if (localKey.length !== 32) throw new Error('Invalid local encryption key')
    return localKey
  }
  const value = requireSetting('ENCRYPTION_KEY')
  if (!/^[a-f\d]{64}$/i.test(value))
    throw new Error('ENCRYPTION_KEY must be 32 bytes in hexadecimal')
  return Buffer.from(value, 'hex')
}
export const secretHash = (value: string) => createHmac('sha256', key()).update(value).digest('hex')
export function encrypt(value: string, purpose = 'getgpt') {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key(), iv)
  cipher.setAAD(Buffer.from(purpose))
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')
}
export function decrypt(value: string, purpose = 'getgpt') {
  const input = Buffer.from(value, 'base64')
  const cipher = createDecipheriv('aes-256-gcm', key(), input.subarray(0, 12))
  cipher.setAAD(Buffer.from(purpose))
  cipher.setAuthTag(input.subarray(12, 28))
  return Buffer.concat([cipher.update(input.subarray(28)), cipher.final()]).toString('utf8')
}
