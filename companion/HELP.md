## Ross Carbonite/Vision

To make sense of the input and output names available in the actions provided by this module, you might want to read the bottom of this [reference manual.](http://help.rossvideo.com/carbonite-device/Topics/Protocol/RossTalk/CNT/RT-CNT-Comm.html)



**Available commands for All Versions**
* Trigger GPI
* Trigger GPI by Name
* Run Custom Command

**Available commands for Ross Carbonite / Vision**

* Fire custom control
* Load Set
* Cut
* Auto Transition
* XPT
* Transition Keyer
* Fade to black

**Acuity / Vision: scanning the switcher**

With the *Acuity/Vision* model and *Scan switcher on connect* ticked, the module asks the switcher for its input names, the AUX buses, the number of MLEs and the software version (using the `?` queries of `XPT` and `MNEM`). With *TCP Keep Alive* on the scan runs over the persistent connection when it is established; without it, over a short connection of its own each time the configuration is saved. The result is available as:

* Variables: `version`, `me_count`, `input_count`, `aux_bank_count`, `aux_count` and `input_<n>_name` (e.g. `$(rosstalk:input_1_name)`)
* Action *XPT (choose from scanned list)*, with the destinations and sources found
* Action *Re-scan switcher*, to pick up renamed inputs

Vision wants `MLE` where Acuity accepts both `ME` and `MLE`; the scan detects which one the switcher answers to. If a scan finds nothing, the module log shows the first replies the switcher gave, which tells what is going on. Variables stay at 0 until a scan has succeeded.

**Logging**

Every command sent and every response received is written to the module log (tick *Log commands and responses* off to move them to debug level). Connection problems, commands that could not be sent and a switcher closing the connection are logged as warnings or errors.

**Available commands for Ross Xpression**

This module does not support Xpression, instead use the dedicated module: [companion-module-rossvideo-xpression](https://github.com/bitfocus/companion-module-rossvideo-xpression)

**Ultrix**

* RUN, PAUSE, STOP, END timers

If you wish to control the Ross Ultrix router crosspoints then the Companion SWP-08 module is the best method.
