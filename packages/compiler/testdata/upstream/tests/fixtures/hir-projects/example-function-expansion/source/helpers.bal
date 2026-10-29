function shared(int value) returns int { return adjust(value); }
function adjust(int value) returns int { return value + 1; }
function countdown(int value) returns int {
    if value <= 0 { return 0; }
    return countdown(value - 1);
}
function evenStep(int value) returns int {
    if value <= 0 { return 0; }
    return oddStep(value - 1);
}
function oddStep(int value) returns int {
    if value <= 0 { return 1; }
    return evenStep(value - 1);
}
