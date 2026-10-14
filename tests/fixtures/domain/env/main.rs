use std::env;
fn main() {
    let a = env::var("RS_A");
    let b = std::env::var("RS_B");
    // env::var("RS_COMMENTED")
}
