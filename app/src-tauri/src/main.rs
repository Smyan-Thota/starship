// Starship.app has no console window.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    starship_lib::run()
}
