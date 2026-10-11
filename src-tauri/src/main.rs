// Pas de console sous Windows en release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    trackfetcher_lib::run()
}
