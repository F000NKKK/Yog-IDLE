//! Yog-IDLE — visual UI editor for Yog mods, built on Substrate Platform.
//!
//! Panel layout is modeled after Visual Studio (not VS Code): a Toolbox on
//! the left, a Solution Explorer + Properties stack on the right, an Output
//! log along the bottom, and the Designer canvas filling the center.

use egui_dock::{DockState, NodeIndex};
use substrate_platform::Panel;

struct DesignerPanel;
impl Panel for DesignerPanel {
    fn title(&self) -> String {
        "Designer".into()
    }
    fn ui(&mut self, ui: &mut egui::Ui) {
        ui.label("Widget tree canvas goes here.");
    }
}

struct ToolboxPanel;
impl Panel for ToolboxPanel {
    fn title(&self) -> String {
        "Toolbox".into()
    }
    fn ui(&mut self, ui: &mut egui::Ui) {
        ui.label("Widget kinds go here.");
    }
}

struct SolutionExplorerPanel;
impl Panel for SolutionExplorerPanel {
    fn title(&self) -> String {
        "Solution Explorer".into()
    }
    fn ui(&mut self, ui: &mut egui::Ui) {
        ui.label("Widget tree goes here.");
    }
}

struct PropertiesPanel;
impl Panel for PropertiesPanel {
    fn title(&self) -> String {
        "Properties".into()
    }
    fn ui(&mut self, ui: &mut egui::Ui) {
        ui.label("Selected widget's Style fields go here.");
    }
}

struct OutputPanel;
impl Panel for OutputPanel {
    fn title(&self) -> String {
        "Output".into()
    }
    fn ui(&mut self, ui: &mut egui::Ui) {
        ui.label("Live-connection log goes here.");
    }
}

fn build_dock_state() -> DockState<Box<dyn Panel>> {
    let mut dock_state = DockState::new(vec![Box::new(DesignerPanel) as Box<dyn Panel>]);
    let surface = dock_state.main_surface_mut();
    let root = NodeIndex::root();

    let [designer, _output] =
        surface.split_below(root, 0.75, vec![Box::new(OutputPanel) as Box<dyn Panel>]);
    let [designer, _toolbox] = surface.split_left(
        designer,
        0.18,
        vec![Box::new(ToolboxPanel) as Box<dyn Panel>],
    );
    let [_designer, explorer] = surface.split_right(
        designer,
        0.25,
        vec![Box::new(SolutionExplorerPanel) as Box<dyn Panel>],
    );
    surface.split_below(
        explorer,
        0.5,
        vec![Box::new(PropertiesPanel) as Box<dyn Panel>],
    );

    dock_state
}

fn main() -> eframe::Result<()> {
    let shell = substrate_platform::Shell::new(build_dock_state());
    substrate_platform::run("Yog-IDLE", shell)
}
