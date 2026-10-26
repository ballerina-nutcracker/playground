import ballerina/http;

service /notes on new http:Listener(8080) {
    resource function get first() returns string { return shared("first"); }
    resource function get second() returns string { return shared("second"); }
}

function shared(string value) returns string { return value; }

// racing disk update