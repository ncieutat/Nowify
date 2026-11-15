/**
 * Builds public/idle/list.json: the list of idle-screen photos.
 * Runs automatically before `yarn build` (see "prebuild" in package.json).
 */
const fs = require('fs')
const path = require('path')

const dir = path.join(__dirname, '..', 'public', 'idle')
fs.mkdirSync(dir, { recursive: true })

const files = fs
  .readdirSync(dir)
  .filter(file => /\.(jpe?g|png|webp)$/i.test(file))
  .sort()
  .map(file => `/idle/${encodeURIComponent(file)}`)

fs.writeFileSync(path.join(dir, 'list.json'), JSON.stringify(files, null, 2))
console.log(`idle-list: ${files.length} image(s) found in public/idle`)
