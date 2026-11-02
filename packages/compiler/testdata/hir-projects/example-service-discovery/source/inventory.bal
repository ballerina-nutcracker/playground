import ballerina/http;

service /inventory on new http:Listener(8081) {
    resource function get items() returns string { return sharedLabel(); }
}

function unusedHelper() returns int { return 42; }
