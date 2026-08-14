import { startServer } from './net'

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason)
  process.exit(1)
})

const port = Number(process.env.PORT) || 8080
startServer(port)
console.log(`riftlane server listening on :${port}`)
