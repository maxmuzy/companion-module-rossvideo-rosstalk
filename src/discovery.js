// Switcher discovery for Acuity/Vision.
//
// RossTalk has no "list" commands, but XPT and MNEM accept '?' in place of the selection and answer with
// one line of text (e.g. `XPT AUX:5:5:?` -> `BK`, `MNEM IN:1:?` -> `CAM 1`). Unknown sources are answered
// with `No source or Unknown source`. Discovery probes those queries one at a time to find out how many
// inputs / AUX buses / MLEs exist and what the inputs are called.

const QUERY_TIMEOUT = 1500
const MAX_TIMEOUTS_IN_A_ROW = 3

const MAX_INPUTS = 128
const MAX_INPUT_MISSES_IN_A_ROW = 3
const MAX_AUX_BANKS = 16
const MAX_AUX_BANK_MISSES_IN_A_ROW = 2
const MAX_AUX_PER_BANK = 64
const MAX_MES = 8

// Start of the error texts the switcher answers with when a queried source does not exist
const ERROR_REPLY = /^(no source|unknown|invalid|error|syntax|not )/i

class ScanAborted extends Error {
	constructor(message) {
		super(message)
		this.silent = message === undefined
	}
}

module.exports = {
	resetDiscovery() {
		let self = this
		self.cancelDiscovery()
		self.discovery = { version: undefined, mePrefix: undefined, mes: [], inputs: [], aux: [] }
	},

	// Stops a running scan, if any, and gives up on commands that were waiting for it
	cancelDiscovery() {
		let self = this
		self.discoveryRun++
		self.rejectPending()
		self.rxBuffer = ''
		self.discovering = false
		for (const cmd of self.queuedWrites) {
			self.log('warn', `Command dropped, connection lost during scan: ${cmd}`)
		}
		self.queuedWrites = []
	},

	rejectPending() {
		let self = this
		if (self.pendingQuery) {
			const pending = self.pendingQuery
			self.pendingQuery = null
			clearTimeout(pending.timer)
			pending.resolve(null)
		}
	},

	// Everything the switcher sends back arrives here. The first line goes to the query that is waiting for
	// it; anything else (e.g. answers to commands when "Cmd Response" is on) is just logged.
	handleData(data) {
		let self = this
		self.rxBuffer += data.toString('latin1')
		const lines = self.rxBuffer.split(/\r\n|\n|\r/)
		self.rxBuffer = lines.pop()

		for (const line of lines) {
			const text = line.trim()
			if (self.pendingQuery) {
				const pending = self.pendingQuery
				self.pendingQuery = null
				clearTimeout(pending.timer)
				pending.resolve(text)
			} else if (text !== '') {
				self.logRx(text)
			}
		}
	},

	// Sends a query and resolves with the reply line, or null if there was none in time (or no connection)
	queryCommand(cmd, timeout = QUERY_TIMEOUT) {
		let self = this
		return new Promise((resolve) => {
			if (self.socket === undefined || !self.socket.isConnected || self.pendingQuery) {
				resolve(null)
				return
			}

			const timer = setTimeout(() => {
				self.pendingQuery = null
				// Some firmwares might not terminate the line, in which case the text is still sitting here
				const partial = self.rxBuffer.trim()
				self.rxBuffer = ''
				resolve(partial !== '' ? partial : null)
			}, timeout)
			self.pendingQuery = { resolve, timer }

			self.log('debug', `Query: ${cmd}`)
			self.socket.send(cmd + '\r\n').catch((err) => {
				self.log('error', `Failed to send ${cmd}: ${err.message}`)
				self.rejectPending()
			})
		})
	},

	async discover() {
		let self = this
		if (self.config.discover === false || self.config.model !== 'acuity' || !self.config.keepAlive) return
		if (self.socket === undefined || !self.socket.isConnected) {
			self.log('warn', 'Not connected, cannot scan the switcher')
			return
		}

		const runId = ++self.discoveryRun
		const stale = () => runId !== self.discoveryRun
		self.discovering = true
		self.rxBuffer = ''
		self.log('info', 'Scanning switcher (version, MLEs, inputs, AUX buses)')

		let timeoutsInARow = 0
		// Resolves { ok: boolean, value: string }. A reply that is empty or an error text means "does not exist"
		const probe = async (cmd) => {
			const reply = await self.queryCommand(cmd)
			if (stale()) throw new ScanAborted()
			if (reply === null) {
				if (++timeoutsInARow >= MAX_TIMEOUTS_IN_A_ROW) {
					throw new ScanAborted(
						'The switcher is not answering queries, scan aborted. If this keeps happening, check the "Cmd Response" option of the RossTalk port in Com Setup.'
					)
				}
				return { ok: false }
			}
			timeoutsInARow = 0
			self.log('debug', `Reply to ${cmd}: ${reply}`)
			return reply === '' || ERROR_REPLY.test(reply) ? { ok: false } : { ok: true, value: reply }
		}

		const found = { version: undefined, mePrefix: undefined, mes: [], inputs: [], aux: [] }
		try {
			let r = await probe('VERSION')
			if (r.ok) found.version = r.value

			// Vision wants MLE where Acuity accepts both, so see which one this switcher understands
			for (const prefix of ['MLE', 'ME']) {
				r = await probe(`XPT ${prefix}:1:PGM:?`)
				if (r.ok) {
					found.mePrefix = prefix
					found.mes.push(1)
					break
				}
			}
			if (found.mePrefix) {
				for (let me = 2; me <= MAX_MES; me++) {
					r = await probe(`XPT ${found.mePrefix}:${me}:PGM:?`)
					if (!r.ok) break
					found.mes.push(me)
				}
			}

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

			self.discovery = found
			self.refreshVariables()
			self.actions()
			self.log('info', self.describeDiscovery())
		} catch (err) {
			if (!(err instanceof ScanAborted)) throw err
			if (!err.silent) self.log('warn', err.message)
		} finally {
			if (!stale()) {
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
		if (self.config.model !== 'acuity' || !self.config.keepAlive || self.config.discover === false) return {}

		const d = self.discovery
		const actions = {
			rescan: {
				name: 'Re-scan switcher (input names, AUX buses, MLEs)',
				options: [],
				callback: async () => {
					await self.discover()
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
