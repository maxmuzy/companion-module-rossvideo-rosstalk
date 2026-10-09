// Switcher discovery for Acuity/Vision.
//
// RossTalk has no "list" commands, but XPT and MNEM accept '?' in place of the selection and answer with
// one line of text (e.g. `XPT AUX:5:5:?` -> `BK`, `MNEM IN:1:?` -> `CAM 1`). Unknown sources are answered
// with `No source or Unknown source`. Discovery probes those queries one at a time to find out how many
// inputs / AUX buses / MLEs exist and what the inputs are called.

const { TCPHelper, InstanceStatus } = require('@companion-module/base')

const QUERY_TIMEOUT = 1000
const CONNECT_TIMEOUT = 5000
const MAX_TIMEOUTS_WITHOUT_ANY_REPLY = 3

const MAX_INPUTS = 128
const MAX_INPUT_MISSES_IN_A_ROW = 3
const MAX_AUX_BANKS = 16
const MAX_AUX_BANK_MISSES_IN_A_ROW = 2
const MAX_AUX_PER_BANK = 64
const MAX_MES = 8
const TRACE_SIZE = 8

// Start of the error texts the switcher answers with when a queried source does not exist
const ERROR_REPLY = /^(no source|unknown|invalid|error|syntax|not )/i

class ScanAborted extends Error {
	constructor(message) {
		super(message)
		this.silent = message === undefined
	}
}

// Sends queries over a socket and matches each one with the next line the switcher sends back.
// One query at a time: the answers carry no identifier.
class QuerySession {
	constructor(socket, onUnsolicited, log) {
		this.socket = socket
		this.onUnsolicited = onUnsolicited
		this.log = log
		this.buffer = ''
		this.pending = null
	}

	handleData(data) {
		this.buffer += data.toString('latin1')
		const lines = this.buffer.split(/\r\n|\n|\r/)
		this.buffer = lines.pop()
		for (const line of lines) this.handleLine(line.trim())
	}

	handleLine(text) {
		// Terminator quirks can leave blank lines behind, they never are an answer
		if (text === '') return

		const pending = this.pending
		if (pending === null) {
			this.onUnsolicited(text)
		} else if (text.toLowerCase() !== pending.cmd.toLowerCase()) {
			// (a line equal to the query itself is the switcher echoing what it received)
			this.pending = null
			clearTimeout(pending.timer)
			pending.resolve(text)
		}
	}

	// Resolves with the reply line, or null if there was none in time (or no connection)
	query(cmd, timeout) {
		return new Promise((resolve) => {
			if (!this.socket.isConnected || this.pending !== null) {
				resolve(null)
				return
			}

			// Drop whatever is left of the previous answer
			this.buffer = ''
			const timer = setTimeout(() => {
				this.pending = null
				// Some firmwares might not terminate the line, in which case the text is still sitting here
				const partial = this.buffer.trim()
				this.buffer = ''
				resolve(partial !== '' && partial.toLowerCase() !== cmd.toLowerCase() ? partial : null)
			}, timeout)
			this.pending = { cmd, resolve, timer }

			this.log('debug', `Query: ${cmd}`)
			this.socket.send(cmd + '\r\n').catch((err) => {
				this.log('error', `Failed to send ${cmd}: ${err.message}`)
				this.cancel()
			})
		})
	}

	cancel() {
		if (this.pending !== null) {
			const pending = this.pending
			this.pending = null
			clearTimeout(pending.timer)
			pending.resolve(null)
		}
		this.buffer = ''
	}
}

module.exports = {
	QuerySession,

	resetDiscovery() {
		let self = this
		self.cancelDiscovery()
		self.discovery = { version: undefined, mePrefix: undefined, mes: [], inputs: [], aux: [] }
	},

	// Stops a running scan, if any, and gives up on commands that were waiting for it
	cancelDiscovery() {
		let self = this
		self.discoveryRun++
		if (self.session) self.session.cancel()
		if (self.scanSession) self.scanSession.cancel()
		self.discovering = false
		for (const cmd of self.queuedWrites) {
			self.log('warn', `Command dropped, connection lost during scan: ${cmd}`)
		}
		self.queuedWrites = []
	},

	// Why a scan would not run, or undefined if it can
	scanBlocker() {
		if (this.config.discover === false) return 'disabled in the module configuration'
		if (this.config.model !== 'acuity') return 'only available for the Acuity/Vision model'
		if (!this.config.host) return 'no host configured'
		return undefined
	},

	// Called by the module once the configuration is applied (without Keep Alive) or the connection is up (with it)
	scan() {
		let self = this
		const blocker = self.scanBlocker()
		if (blocker) {
			if (self.config.discover !== false) self.log('info', `Switcher scan skipped: ${blocker}`)
			return Promise.resolve()
		}

		if (self.config.keepAlive) {
			if (self.socket === undefined || !self.socket.isConnected) {
				self.log('warn', 'Not connected, cannot scan the switcher')
				return Promise.resolve()
			}
			return self.executeScan(self.session, true)
		}

		// Same queue as the commands, so the switcher never sees two connections at once
		self.oneShotChain = self.oneShotChain.then(() => self.scanWithTemporaryConnection())
		return self.oneShotChain
	},

	// Without Keep Alive: connect just for the scan. Never rejects.
	scanWithTemporaryConnection() {
		let self = this
		return new Promise((resolve) => {
			const host = self.config.host
			const port = self.getPort()
			const socket = new TCPHelper(host, port, { reconnect: false })
			self.oneShotSockets.add(socket)

			let session = null
			let finished = false
			const finish = () => {
				if (finished) return
				finished = true
				clearTimeout(connectTimer)
				if (session) session.cancel()
				if (self.scanSession === session) self.scanSession = null
				self.oneShotSockets.delete(socket)
				socket.destroy()
				resolve()
			}
			const connectTimer = setTimeout(() => {
				self.log('error', `Timed out connecting to ${host}, switcher not scanned`)
				self.updateStatus(InstanceStatus.ConnectionFailure, 'Timeout')
				finish()
			}, CONNECT_TIMEOUT)

			socket.on('connect', async () => {
				clearTimeout(connectTimer)
				self.updateStatus(InstanceStatus.Ok)
				session = new QuerySession(
					socket,
					(text) => self.logRx(text),
					(level, message) => self.log(level, message)
				)
				self.scanSession = session
				try {
					await self.executeScan(session, false)
				} catch (err) {
					self.log('error', `Scan failed: ${err.message}`)
				}
				finish()
			})
			socket.on('data', (data) => {
				if (session) session.handleData(data)
			})
			socket.on('error', (err) => {
				self.log('error', `Network error: ${err.message}, switcher not scanned`)
				self.updateStatus(InstanceStatus.ConnectionFailure, err.code)
				finish()
			})
			socket.on('end', () => {
				if (finished) return
				self.log('warn', `${host} closed the connection during the scan`)
				finish()
			})
		})
	},

	// holdWrites: with a persistent connection, commands wait until the scan is done so their
	// replies (if the switcher sends any) cannot be mistaken for the answer to a query
	async executeScan(session, holdWrites) {
		let self = this

		const runId = ++self.discoveryRun
		const stale = () => runId !== self.discoveryRun
		const timeout = self.queryTimeout ?? QUERY_TIMEOUT
		if (holdWrites) self.discovering = true
		self.log('info', 'Scanning switcher (inputs, AUX buses, MLEs, version)')

		let timeoutsWithoutReply = 0
		let replies = 0
		const trace = []

		// Resolves { ok, value }. A reply that is an error text means "does not exist"; so does no reply at all.
		// Optional probes (ok to be unsupported by the switcher) never make the scan give up.
		const probe = async (cmd, optional = false) => {
			const reply = await session.query(cmd, timeout)
			if (stale()) throw new ScanAborted()
			if (trace.length < TRACE_SIZE) trace.push(`${cmd} -> ${reply === null ? '(no reply)' : JSON.stringify(reply)}`)

			if (reply === null) {
				if (!optional && replies === 0 && ++timeoutsWithoutReply >= MAX_TIMEOUTS_WITHOUT_ANY_REPLY) {
					throw new ScanAborted(
						'The switcher is not answering queries, scan aborted. If this keeps happening, check the "Cmd Response" option of the RossTalk port in Com Setup.'
					)
				}
				return { ok: false }
			}
			replies++
			self.log('debug', `Reply to ${cmd}: ${reply}`)
			return ERROR_REPLY.test(reply) ? { ok: false } : { ok: true, value: reply }
		}

		const found = { version: undefined, mePrefix: undefined, mes: [], inputs: [], aux: [] }
		try {
			let r
			let misses = 0
			for (let input = 1; input <= MAX_INPUTS && misses < MAX_INPUT_MISSES_IN_A_ROW; input++) {
				r = await probe(`MNEM IN:${input}:?`)
				if (r.ok) {
					misses = 0
					found.inputs.push({ id: input, name: r.value })
				} else {
					misses++
				}
			}

			let bankMisses = 0
			for (let bank = 1; bank <= MAX_AUX_BANKS && bankMisses < MAX_AUX_BANK_MISSES_IN_A_ROW; bank++) {
				let count = 0
				for (let num = 1; num <= MAX_AUX_PER_BANK; num++) {
					r = await probe(`XPT AUX:${bank}:${num}:?`)
					if (!r.ok) break
					found.aux.push({ bank, num })
					count++
				}
				bankMisses = count > 0 ? 0 : bankMisses + 1
			}

			// Vision wants MLE where Acuity accepts both, so see which one this switcher understands
			for (const prefix of ['MLE', 'ME']) {
				r = await probe(`XPT ${prefix}:1:PGM:?`, true)
				if (r.ok) {
					found.mePrefix = prefix
					found.mes.push(1)
					break
				}
			}
			if (found.mePrefix) {
				for (let me = 2; me <= MAX_MES; me++) {
					r = await probe(`XPT ${found.mePrefix}:${me}:PGM:?`, true)
					if (!r.ok) break
					found.mes.push(me)
				}
			}

			r = await probe('VERSION', true)
			if (r.ok) found.version = r.value

			self.discovery = found
			self.refreshVariables()
			self.actions()
			if (found.inputs.length === 0 && found.aux.length === 0) {
				self.log('warn', `Scan found no inputs and no AUX buses. First exchanges: ${trace.join(' | ')}`)
			} else {
				self.log('info', self.describeDiscovery())
			}
		} catch (err) {
			if (!(err instanceof ScanAborted)) throw err
			if (!err.silent) self.log('warn', `${err.message} First exchanges: ${trace.join(' | ')}`)
		} finally {
			if (holdWrites && !stale()) {
				self.discovering = false
				const queued = self.queuedWrites
				self.queuedWrites = []
				for (const cmd of queued) self.writeRaw(cmd)
			}
		}
	},

	describeDiscovery() {
		const d = this.discovery
		const banks = new Map()
		for (const a of d.aux) banks.set(a.bank, (banks.get(a.bank) || 0) + 1)
		const auxText = [...banks].map(([bank, count]) => `bank ${bank}: ${count}`).join(', ')
		const inputText = d.inputs.map((i) => `${i.id}=${i.name}`).join(', ')
		return (
			`Scan complete. Software: ${d.version ?? 'unknown'}. ` +
			`${d.mePrefix ? `${d.mes.length} ${d.mePrefix}(s)` : 'No MLEs found'}. ` +
			`${d.inputs.length} input(s)${inputText ? ` (${inputText})` : ''}. ` +
			`${d.aux.length} AUX bus(es)${auxText ? ` (${auxText})` : ''}.`
		)
	},

	refreshVariables() {
		let self = this
		const d = self.discovery
		const definitions = [
			{ variableId: 'version', name: 'Switcher software version' },
			{ variableId: 'me_count', name: 'Number of MLEs found' },
			{ variableId: 'input_count', name: 'Number of inputs found' },
			{ variableId: 'aux_bank_count', name: 'Number of AUX banks found' },
			{ variableId: 'aux_count', name: 'Number of AUX buses found (all banks)' },
		]
		const values = {
			version: d.version ?? '',
			me_count: d.mes.length,
			input_count: d.inputs.length,
			aux_bank_count: new Set(d.aux.map((a) => a.bank)).size,
			aux_count: d.aux.length,
		}
		for (const input of d.inputs) {
			definitions.push({ variableId: `input_${input.id}_name`, name: `Name of input ${input.id}` })
			values[`input_${input.id}_name`] = input.name
		}
		self.setVariableDefinitions(definitions)
		self.setVariableValues(values)
	},

	// Actions that depend on what the scan found
	discoveryActions() {
		let self = this
		if (self.config.model !== 'acuity' || self.config.discover === false) return {}

		const d = self.discovery
		const actions = {
			rescan: {
				name: 'Re-scan switcher (input names, AUX buses, MLEs)',
				options: [],
				callback: async () => {
					await self.scan()
				},
			},
		}

		const me = d.mePrefix
		const destinations = [
			...d.mes.flatMap((n) => [
				{ id: `${me}:${n}:PGM`, label: `${me} ${n} Program` },
				{ id: `${me}:${n}:PST`, label: `${me} ${n} Preset` },
			]),
			...d.aux.map((a) => ({ id: `AUX:${a.bank}:${a.num}`, label: `AUX bank ${a.bank} #${a.num}` })),
		]
		const sources = [
			...d.inputs.map((i) => ({ id: `IN:${i.id}`, label: `${i.id}: ${i.name}` })),
			{ id: 'BK', label: 'Black' },
			...d.mes.flatMap((n) => [
				{ id: `${me}:${n}:PGM`, label: `${me} ${n} Program` },
				{ id: `${me}:${n}:PV`, label: `${me} ${n} Preview` },
			]),
		]

		if (destinations.length > 0 && d.inputs.length > 0) {
			actions.xptList = {
				name: 'XPT (choose from scanned list)',
				description: 'Destinations and sources found by scanning the switcher',
				options: [
					{
						type: 'dropdown',
						label: 'Destination',
						id: 'vidDest',
						default: destinations[0].id,
						choices: destinations,
					},
					{
						type: 'dropdown',
						label: 'Source',
						id: 'vidSource',
						default: sources[0].id,
						choices: sources,
					},
				],
				callback: async (event) => {
					self.sendCommand('XPT ' + event.options.vidDest + ':' + event.options.vidSource)
				},
			}
		}

		return actions
	},
}
