public function main() {
    int count = 3;
    while count > 0 {
        count -= 1;
    }
    _ = finish(count);
}

function finish(int count) returns int { return count; }
