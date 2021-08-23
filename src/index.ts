import http from 'http'
import createExpressApp, * as express from 'express'
import {
  Client as HyperspaceClient,
  Server as HyperspaceServer
} from 'hyperspace'
// @ts-ignore We dont need types for getNetworkOptions
import getNetworkOptions from '@hyperspace/rpc/socket.js'
import { EventEmitter } from 'events'
import net from 'net'
import dht from '@hyperswarm/dht'
import ram from 'random-access-memory'
import WebSocket, * as ws from 'ws'

interface HyperDHT extends EventEmitter {
  listen: () => void
  address: () => {port: number}
  destroy: () => void
}

declare module 'ws' {
  // HACK temporary workaround for the 'ws' module having bad types, should be fixed soon -prf
  class WebSocketServer extends ws.Server {}
}

// globals
// =

let hyperServer: HyperspaceServer | undefined = undefined
let hyperClient: HyperspaceClient | undefined = undefined
let dhtInst: HyperDHT | undefined = undefined

const SIMULATE_HYPERSPACE = process.env.SIMULATE_HYPERSPACE === '1'
const HYPERSPACE_HOST = SIMULATE_HYPERSPACE ? `hyperspace-simulator-${process.pid}` : process.env.HYPERSPACE_HOST
const HYPERSPACE_STORAGE = SIMULATE_HYPERSPACE ? ram : process.env.HYPERSPACE_STORAGE

setup()
async function setup () {
  if (SIMULATE_HYPERSPACE) {
    dhtInst = dht({
      bootstrap: false
    })
    if (!dhtInst) throw new Error('Failed to create local DHT for simulation')
    dhtInst.listen()
    await new Promise(resolve => {
      return dhtInst?.once('listening', resolve)
    })
    const bootstrapPort = dhtInst.address().port
    const bootstrapOpt = [`localhost:${bootstrapPort}}`]

    hyperServer = new HyperspaceServer({
      host: HYPERSPACE_HOST,
      storage: HYPERSPACE_STORAGE,
      network: {
        bootstrap: bootstrapOpt,
        preferredPort: 0
      },
      noMigrate: true
    })
    await hyperServer.open()
    hyperClient = new HyperspaceClient({host: HYPERSPACE_HOST})
  } else {
    try {
      hyperClient = new HyperspaceClient({host: HYPERSPACE_HOST})
      await hyperClient.ready()
    } catch (e) {
      // no daemon, start it in-process
      hyperServer = new HyperspaceServer({host: HYPERSPACE_HOST, storage: HYPERSPACE_STORAGE})
      await hyperServer.ready()
      hyperClient = new HyperspaceClient({host: HYPERSPACE_HOST})
      await hyperClient.ready()
    }

    console.log('Hyperspace daemon connected, status:')
    console.log(JSON.stringify(await hyperClient.status()))
  }

  const app = createExpressApp()
  app.get('/', (req: express.Request, res: express.Response) => {
    res.status(200).end('Hypercore Protocol server active')
  })

  const wsServer = new ws.WebSocketServer({ noServer: true })
  wsServer.on('connection', (socket: WebSocket, req: http.IncomingMessage) => {
    if (/\/_api\/hyper(\?|\/$|$)/.test(req.url || '/')) {
      const hypSocket = net.connect(getNetworkOptions({host: HYPERSPACE_HOST}))
      const wsStream = ws.createWebSocketStream(socket)
      wsStream.pipe(hypSocket).pipe(wsStream)
    } else {
      socket.close()
    }
  })

  const PORT = Number(process.env.ATEK_ASSIGNED_PORT)
  const server = new http.Server(app)
  server.listen(PORT, () => {
    console.log(`Hypercore Protocol server running at: http://localhost:${PORT}/`)
  })
  server.on('upgrade', (request: http.IncomingMessage, socket, head) => {
    wsServer.handleUpgrade(request, (socket as net.Socket), head, (socket: WebSocket) => {
      wsServer.emit('connection', socket, request)
    })
  })
}

process.on('exit', async () => {
  if (hyperClient) await hyperClient.close()
  if (hyperServer) {
    console.log('Shutting down Hyperspace, this may take a few seconds...')
    await hyperServer.close()
  }
  if (dhtInst) await dhtInst.destroy()
})
