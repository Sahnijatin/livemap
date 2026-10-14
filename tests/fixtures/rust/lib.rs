pub fn start() {}

struct Order {}

enum Status { A }

trait Repo {}

impl Repo for Db {
    fn find(&self) {}
}

mod api;
