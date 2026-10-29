import ballerina/http;
import examples/definitions_and_calls.math;

final int minimumAmount = 5;
final string upstream = "http://localhost:9090";
LocalClient upstreamClient = new ();

client class LocalClient {
    remote function send() returns string { return "sent"; }
}
type Order record {| int amount; |};
type UnusedRecord record {| string description; |};

service /orders on new http:Listener(8080) {
    resource function get total() returns int {
        int local = calculate(minimumAmount);
        return math:calculate(local);
    }
}

function unusedHelper() returns string {
    string status = upstreamClient->send();
    return upstream + ": " + status;
}
