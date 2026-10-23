//! The tracer at work: breakpoints, stops, stepping, frames and values.

use super::*;
use substrate_platform::sync::Locked;
use yog_debugger::LoadedMod;

impl Tracer {
    pub(super) fn attach(
        app: &AppHandle,
        real_pid: i32,
        mod_id: &str,
        native_path: &Path,
    ) -> Result<Self, String> {
        let symbols = SymbolTable::load(native_path)
            .map_err(|e| format!("loading symbols from {}: {e}", native_path.display()))?;
        let mut debugger = Debugger::attach(real_pid as u32).map_err(|e| {
            if e.denied() {
                access::denied_message(real_pid)
            } else {
                format!("attaching to pid {real_pid}: {e}")
            }
        })?;
        debugger.set_pause_filter(is_game_thread);
        // The bias the symbols' addresses are off by (a PE's or Mach-O's
        // addresses aren't relative to where it loaded).
        let found = find_latest_module_base(&debugger, mod_id).map(|b| symbols.load_bias(b));
        let Some(module_base) = found else {
            // Attached but unusable — let the game go rather than leaving
            // it stopped.
            let _ = debugger.detach();
            return Err(format!(
                "couldn't locate {mod_id}'s native in pid {real_pid}'s memory map"
            ));
        };

        let generations = GenerationAllocator::new();
        let mut tracer = Tracer {
            debugger,
            native_path: native_path.to_path_buf(),
            symbols,
            module_base,
            mod_id: mod_id.to_string(),
            generation: generations.next(),
            generations,
            breakpoints: SourceBreakpoints::new(),
            last_stop: StopReason::Interrupted,
            values: HashMap::new(),
            next_value: 1,
        };
        for (file, line) in BREAKPOINTS.locked().clone() {
            tracer.set_breakpoint(app, file, line);
        }
        Ok(tracer)
    }

    pub(super) fn apply(&mut self, app: &AppHandle, cmd: TracerCmd) {
        match cmd {
            TracerCmd::SetBreakpoint { file, line } => self.set_breakpoint(app, file, line),
            TracerCmd::ClearBreakpoint { file, line } => {
                if let Err(e) =
                    self.breakpoints
                        .clear(&mut self.debugger, &self.mod_id, &file, line)
                {
                    warn(app, format!("clearing breakpoint {file}:{line}: {e}"));
                }
            }
            TracerCmd::Rebind => {
                if let Err(e) = self.rebind() {
                    warn(app, format!("re-binding breakpoints after hot reload: {e}"));
                }
            }
            // Only meaningful while paused, where `tracer_main` handles
            // them itself — one arriving mid-run is a stale double-click.
            TracerCmd::SelectThread(tid) => match self.debugger.select_thread(tid) {
                Ok(()) => self.emit_stop(app, self.last_stop.clone()),
                Err(e) => warn(app, format!("selecting thread {tid}: {e}")),
            },
            TracerCmd::Inspect(query) => query(self),
            TracerCmd::Detach { done } => {
                let _ = self.debugger.detach();
                let _ = done.send(());
            }
            // Already paused (a Pause racing a breakpoint hit) — nothing to do.
            TracerCmd::Pause => {}
            TracerCmd::Continue | TracerCmd::Step(_) => {}
        }
    }

    pub(super) fn rebind(&mut self) -> Result<(), String> {
        let symbols = SymbolTable::load(&self.native_path)
            .map_err(|e| format!("loading symbols from {}: {e}", self.native_path.display()))?;
        let module_base = find_latest_module_base(&self.debugger, &self.mod_id)
            .map(|b| symbols.load_bias(b))
            .ok_or_else(|| format!("couldn't locate {}'s reloaded native", self.mod_id))?;
        let generation = self.generations.next();
        let m = LoadedMod {
            id: &self.mod_id,
            generation,
            base: module_base,
            symbols: &symbols,
        };
        self.breakpoints
            .rebind_after_reload(&mut self.debugger, &m)
            .map_err(|e| e.to_string())?;
        self.symbols = symbols;
        self.values.clear();
        self.module_base = module_base;
        self.generation = generation;
        Ok(())
    }

    /// Arms `file:line` unless it's already tracked (`SourceBreakpoints`
    /// itself would happily track a duplicate), reporting both outright
    /// failures and lines that don't map to any code in the native.
    pub(super) fn set_breakpoint(&mut self, app: &AppHandle, file: String, line: u32) {
        if self
            .breakpoints
            .all()
            .iter()
            .any(|bp| bp.file == file && bp.line == line)
        {
            return;
        }
        let m = LoadedMod {
            id: &self.mod_id,
            generation: self.generation,
            base: self.module_base,
            symbols: &self.symbols,
        };
        match self.breakpoints.set(&mut self.debugger, &m, &file, line) {
            Err(e) => warn(app, format!("setting breakpoint {file}:{line}: {e}")),
            Ok(()) => {
                if self
                    .breakpoints
                    .all()
                    .last()
                    .is_some_and(|bp| bp.addr.is_none())
                {
                    warn(
                        app,
                        format!(
                            "breakpoint {file}:{line} doesn't map to any code in {}'s native — it won't be hit",
                            self.mod_id
                        ),
                    );
                }
            }
        }
    }

    /// After a pause, show a thread that's actually in the mod's own code
    /// if there is one; otherwise the main thread.
    pub(super) fn select_interesting_thread(&mut self) {
        for tid in self.debugger.threads() {
            if self.debugger.select_thread(tid).is_ok()
                && self
                    .stack_trace()
                    .iter()
                    .any(|f| !is_library_source(Path::new(&f.file)))
            {
                return;
            }
        }
        let leader = self.debugger.threads().first().copied();
        if let Some(leader) = leader {
            let _ = self.debugger.select_thread(leader);
        }
    }

    /// The selected thread's physical frames, unwound by CFI — through
    /// `std`, which keeps no frame pointers.
    pub(super) fn frames(&self) -> Vec<FrameRegs> {
        self.debugger
            .backtrace_with(&self.symbols, self.module_base, 64)
            .unwrap_or_default()
    }

    /// Every frame in the mod's native — user code and the `std` statically
    /// linked into it — innermost first, with inlined calls as frames of
    /// their own. `id` encodes the physical frame (see `FRAME_ID_STRIDE`);
    /// `std`'s `/rustc/<commit>/...` paths point into the local `rust-src`.
    pub(super) fn stack_trace(&self) -> Vec<StackFrameOut> {
        let mut out = Vec::new();
        for (i, regs) in self.frames().iter().enumerate() {
            let Some(offset) = regs.pc().checked_sub(self.module_base) else {
                continue;
            };
            for (j, location) in self.symbols.resolve_inlined(offset).into_iter().enumerate() {
                if location.line == 0 || j >= FRAME_ID_STRIDE {
                    continue;
                }
                out.push(StackFrameOut {
                    id: (i * FRAME_ID_STRIDE + j) as i64,
                    name: location.function.unwrap_or_else(|| "<unknown>".to_string()),
                    file: map_rust_src(&location.file.to_string_lossy()),
                    line: location.line,
                });
            }
        }
        out
    }

    /// The registers of the selected thread's frame `frame` (a
    /// `stack_trace` id) and the index of the function instance at its pc
    /// the id names — an inlined call's caller shows its own variables,
    /// not the callee's. The innermost frame has every register; outer
    /// ones have what CFI recovered (the stack pointer, the pc and the
    /// callee-saved registers), so variables kept in other registers read as
    /// `<unavailable>`.
    pub(super) fn frame_regs(&self, frame: usize) -> Result<(FrameRegs, usize), String> {
        let frames = self.frames();
        let regs = frames
            .get(frame / FRAME_ID_STRIDE)
            .ok_or_else(|| format!("frame {frame} is past the end of the stack"))?;
        Ok((regs.clone(), frame % FRAME_ID_STRIDE))
    }

    /// A row for the UI, remembering its expandable value under a handle.
    pub(super) fn row(&mut self, node: ValueNode) -> VariableOut {
        let handle = node.children.map(|value| {
            let id = self.next_value;
            self.next_value += 1;
            self.values.insert(id, value);
            id
        });
        VariableOut {
            name: node.name,
            type_name: node.type_name,
            value: node.value,
            children: Vec::new(),
            expr: node.expr,
            handle,
        }
    }

    /// Locals of the selected thread's frame `frame`, one level at a time.
    pub(super) fn variables(&mut self, frame: usize) -> Result<Vec<VariableOut>, String> {
        let (regs, inline) = self.frame_regs(frame)?;
        let nodes =
            self.symbols
                .local_nodes(&regs, self.module_base, &self.debugger.memory(), inline);
        Ok(nodes.into_iter().map(|n| self.row(n)).collect())
    }

    /// Watch expressions evaluated in frame `frame`.
    pub(super) fn evaluate(
        &mut self,
        frame: usize,
        exprs: &[String],
    ) -> Result<Vec<WatchOut>, String> {
        let (regs, inline) = self.frame_regs(frame)?;
        let results: Vec<_> = {
            let mem = self.debugger.memory();
            exprs
                .iter()
                .map(|expr| {
                    self.symbols
                        .evaluate(expr, &regs, self.module_base, &mem, inline)
                })
                .collect()
        };
        Ok(results
            .into_iter()
            .map(|result| match result {
                Ok(node) => WatchOut {
                    value: Some(self.row(node)),
                    error: None,
                },
                Err(e) => WatchOut {
                    value: None,
                    error: Some(e.to_string()),
                },
            })
            .collect())
    }

    /// The rows under an expandable row from this same stop.
    pub(super) fn children(&mut self, handle: u64) -> Result<Vec<VariableOut>, String> {
        let value = self
            .values
            .get(&handle)
            .cloned()
            .ok_or("the value is no longer available — the game has run since")?;
        let nodes = self.symbols.expand(&value, &self.debugger.memory());
        Ok(nodes.into_iter().map(|n| self.row(n)).collect())
    }

    pub(super) fn emit_stop(&self, app: &AppHandle, reason: StopReason) {
        let reason_str = match reason {
            StopReason::Breakpoint(_) => "breakpoint",
            StopReason::Step => "step",
            StopReason::Interrupted => "pause",
            StopReason::Exited(_) | StopReason::Killed(_) => "exited",
        };
        let exited = reason_str == "exited";
        let thread = self.debugger.current_thread();
        let threads = if exited {
            Vec::new()
        } else {
            self.debugger
                .threads()
                .into_iter()
                .map(|tid| ThreadOut {
                    id: tid,
                    name: self.debugger.thread_name(tid),
                    stopped: self.debugger.is_stopped(tid),
                })
                .collect()
        };
        let registers = match self.debugger.registers() {
            Ok(r) if !exited => r
                .named
                .into_iter()
                .map(|(name, value)| (name.to_string(), format!("{value:#018x}")))
                .collect(),
            _ => Vec::new(),
        };
        let _ = app.emit(
            crate::events::DEBUG_STOPPED,
            DebugStoppedEvent {
                reason: reason_str.to_string(),
                stack_trace: if exited {
                    Vec::new()
                } else {
                    self.stack_trace()
                },
                threads,
                thread,
                registers,
            },
        );
    }
}
