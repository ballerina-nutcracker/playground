import ballerina/http;

service /orders on new http:Listener(8080) {
    resource function get orders() returns string { return formatOrder(); }
    remote function refresh() returns string { return "refreshed"; }
    function formatOrder() returns string { return sharedLabel(); }
}

function sharedLabel() returns string { return "order"; }
