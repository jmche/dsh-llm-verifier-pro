// tsc does not emit .js sources; copy the browser client bundle into lib/.
import { cpSync, mkdirSync } from 'node:fs'
mkdirSync('lib', { recursive: true })
cpSync('src/client.js', 'lib/client.js')
console.log('client.js copied to lib/')
