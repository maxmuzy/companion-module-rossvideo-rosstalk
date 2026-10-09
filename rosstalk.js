const { TCPHelper, InstanceBase, InstanceStatus, runEntrypoint } = require('@companion-module/base')

const config = require('./src/config')
const actions = require('./src/actions')
const discovery = require('./src/discovery')
const upgrades = require('./src/upgrades')

const ONE_SHOT_TIMEOUT = 5000
// A switcher that keeps refusing connections would otherwise log a warning every reconnect
const DISCONNECT_WARN_INTERVAL = 30000

class RossTalkInstance extends InstanceBase {
	constructor(internal) {
		super(internal)
		let self = this

		self.session = null
		self.scanSession = null
		self.discovering = false
		self.discoveryRun = 0
		self.queuedWrites = []
		self.oneShotChain = Promise.resolve()
		self.oneShotSockets = new Set()
		self.lastDisconnectWarn = 0

		// Assign the methods from the listed files to this class
		Object.assign(self, {
			...config,
			...actions,
			...discovery,
		})

		self.resetDiscovery()
	}

	static GetUpgradeScripts() {
		return [upgrades.legacy_upgrade]
	}

	async init(config) {
		let self = this
		self.config = config

		self.updateStatus('connecting', 'Waiting To Connect')
		await self.configUpdated(config)
	}

	async configUpdated(config) {
		let self = this
		self.config = config
		self.resetDiscovery()
		self.refreshVariables()
		self.actions()

		if (self.config.keepAlive) {
			self.init_tcp()
		} else {
			self.closeSocket()
			self.updateStatus(InstanceStatus.Ok)
			self.scan()
		}
	}

	logTx(cmd) {
		this.log(this.config.logCommands === false ? 'debug' : 'info', `Sent: ${cmd}`)
	}

	logRx(text) {
		this.log(this.config.logCommands === false ? 'debug' : 'info', `Received: ${text}`)
	}

	getPort() {
		if (this.config.port === undefined) {
			this.config.port = 7788
		}
		return this.config.port
	}

	// Entry point for every command the actions send
	sendCommand(cmd) {
		let self = this
		if (cmd === undefined) return

		if (!self.config.keepAlive) {
			// One connection per command, one at a time so a busy switcher is never asked for two at once
			self.oneShotChain = self.oneShotChain.then(() => self.sendOneShot(cmd))
			return
		}

		if (self.socket === undefined || !self.socket.isConnected) {
			self.log('warn', `Not connected to ${self.config.host}, command not sent: ${cmd}`)
		} else if (self.discovering) {
			self.log('debug', `Scan in progress, command queued: ${cmd}`)
			self.queuedWrites.push(cmd)
		} else {
			self.writeRaw(cmd)
		}
	}

	async writeRaw(cmd) {
		let self = this
		try {
			const sent = await self.socket.send(cmd + '\r\n')
			if (sent === false) {
				self.log('warn', `Not connected to ${self.config.host}, command not sent: ${cmd}`)
			} else {
				self.logTx(cmd)
			}
		} catch (err) {
			self.log('error', `Failed to send ${cmd}: ${err.message}`)
		}
	}

	// Opens a connection just for this command and closes it again. Never rejects.
	sendOneShot(cmd) {
		let self = this
		return new Promise((resolve) => {
			if (!self.config.host) {
				self.log('warn', `No host configured, command not sent: ${cmd}`)
				resolve()
				return
			}

			const host = self.config.host
			const socket = new TCPHelper(host, self.getPort(), { reconnect: false })
			self.oneShotSockets.add(socket)

			let finished = false
			const finish = () => {
				if (finished) return
				finished = true
				clearTimeout(timer)
				self.oneShotSockets.delete(socket)
				socket.destroy()
				resolve()
			}
			const timer = setTimeout(() => {
				self.log('error', `Timed out connecting to ${host}, command not sent: ${cmd}`)
				self.updateStatus(InstanceStatus.ConnectionFailure, 'Timeout')
				finish()
			}, ONE_SHOT_TIMEOUT)

			socket.on('connect', async () => {
				self.updateStatus(InstanceStatus.Ok)
				try {
					await socket.send(cmd + '\r\n')
					self.logTx(cmd)
				} catch (err) {
					self.log('error', `Failed to send ${cmd}: ${err.message}`)
				}
				finish()
			})
			socket.on('error', (err) => {
				self.log('error', `Network error: ${err.message}, command not sent: ${cmd}`)
				self.updateStatus(InstanceStatus.ConnectionFailure, err.code)
				finish()
			})
			socket.on('end', () => {
				if (finished) return
				self.log('warn', `${host} closed the connection before the command could be sent: ${cmd}`)
				finish()
			})
		})
	}

	// Persistent connection, used when TCP Keep Alive is on
	init_tcp() {
		var self = this

		self.closeSocket()

		self.log('debug', 'Opening socket.')

		if (!self.config.host) {
			self.updateStatus(InstanceStatus.BadConfig, 'No host configured')
			return
		}

		const host = self.config.host
		const port = self.getPort()
		self.socket = new TCPHelper(host, port)
		self.session = new discovery.QuerySession(
			self.socket,
			(text) => self.logRx(text),
			(level, message) => self.log(level, message)
		)

		self.socket.on('status_change', function (status, message) {
			if (status !== 'unknown_error') {
				self.updateStatus(status, message)
			}
		})

		self.socket.on('error', function (err) {
			self.log('debug', 'Network error', JSON.stringify(err))
			self.updateStatus(InstanceStatus.ConnectionFailure, err.code)
			self.log('error', 'Network error: ' + err.message)
		})

		self.socket.on('connect', function () {
			self.updateStatus(InstanceStatus.Ok)
			self.log('info', `Connected to ${host}:${port}`)
			self.scan().catch((err) => self.log('error', `Scan failed: ${err.message}`))
		})

		self.socket.on('end', function () {
			self.cancelDiscovery()
			const now = Date.now()
			const level = now - self.lastDisconnectWarn > DISCONNECT_WARN_INTERVAL ? 'warn' : 'debug'
			self.lastDisconnectWarn = now
			self.log(level, `${host}:${port} closed the connection`)
		})

		self.socket.on('data', function (data) {
			self.session.handleData(data)
		})
	}

	closeSocket() {
		let self = this
		self.cancelDiscovery()
		self.session = null
		if (self.socket !== undefined) {
			self.socket.destroy()
			delete self.socket
		}
	}

	// When module gets deleted
	async destroy() {
		var self = this

		self.closeSocket()
		for (const socket of self.oneShotSockets) {
			socket.destroy()
		}
		self.oneShotSockets.clear()

		self.log('debug', 'destroy', self.id)
	}
}

runEntrypoint(RossTalkInstance, RossTalkInstance.GetUpgradeScripts())
