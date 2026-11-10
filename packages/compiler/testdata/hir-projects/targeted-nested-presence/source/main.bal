public function main() {
    int first = helper();
    int between = 1;
    int second = helper();
    _ = between;
    _ = first;
    _ = second;
}

function helper() returns int {
    return unsupportedBody();
}

function unsupportedBody() returns int {
    panic error("stop");
}

function emptyMain() {
    emptyHelper();
    int between = 2;
    emptyHelper();
    _ = between;
}

function emptyHelper() {
    emptyBody();
}

function emptyBody() {}

function nestedReturns() returns int {
    return returningHelper();
}

function returningHelper() returns int {
    return 7;
}
