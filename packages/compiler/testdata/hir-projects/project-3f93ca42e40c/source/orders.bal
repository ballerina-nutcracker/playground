import ballerina/http;
service /orders on new http:Listener(8080) {
 resource function get [int id](boolean includeItems = false) returns string { _ = id; _ = includeItems; return "order"; }
 remote function refresh(string note = "") returns boolean { _ = note; return true; }
 function formatOrder() returns string { return "order"; }
}
function sharedLabel() returns string { return "order"; }