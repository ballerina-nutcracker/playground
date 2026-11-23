import ballerina/http;

final int minimum = 1;
type Order record {| int amount; |};

service /orders on new http:Listener(8080) {
    resource function post orders() returns int {
        int[] items = [1, 2, 3];
        int total = 0;
        foreach int item in items {
            if item < minimum { continue; }
            total += calculate(item);
        }
        if total > 10 { total += 2; } else { total += 1; }
        return total;
    }
    resource function get status() returns string { return "ready"; }
}

function calculate(int value) returns int {
    if value < 0 { return 0; }
    return value * 2;
}
