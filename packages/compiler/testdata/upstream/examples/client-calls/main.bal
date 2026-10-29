import ballerina/http;

type Person record {|
    string first_name;
    string last_name;
|};

final http:Client testClient = check new ("https://test.com");

service / on new http:Listener(8080) {
    resource function get hello() returns string|error {
        Person person = check testClient->get("/foo/bar");
        return string `hello ${person.first_name} ${person.last_name}`;
    }
}

client class Queue {
    public function init(string host, int port = 9092) {
        _ = host;
        _ = port;
    }
    remote function send(string message, string topic = "jobs") returns string|error {
        return topic + ": " + message;
    }
}

function sendMessage() returns string|error {
    Queue producer = new ("broker", port = 9093);
    string result = check producer->send("hello", topic = "orders");
    return result;
}

function capturePanic() returns string|error {
    string|error result = trap checkpanic sendMessage();
    return result;
}
