public function main() returns error? {
    int mode = 1;
    record {| int value; |} request = {value: mode};
    match mode {
        1 => { mode = 2; }
        _ => { mode = 3; }
    }
    boolean selected = mode > 0 && positive(mode);
    future<int> pending = start compute(mode);
    int result = check wait pending;
    _ = request;
    _ = selected;
    _ = result;
}

function positive(int value) returns boolean { return value > 0; }
function compute(int value) returns int { return value * 2; }
