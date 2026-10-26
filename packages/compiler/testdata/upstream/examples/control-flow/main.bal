public function main() { _ = process([1, 2, 3, 4]); }

function process(int[] values) returns int {
    int total = 0;
    int index = 0;
    while index < 3 {
        index += 1;
        if index == 2 { continue; }
        foreach int value in values {
            if value == 1 { continue; }
            if value > 3 { break; }
            total += value;
        }
        if total > 20 { break; }
    }
    if total < 0 {
        return 0;
    } else if total == 0 {
        total = 1;
    } else {
        total += 2;
    }
    if total > 10 {} else { total += 1; }
    return total;
}
