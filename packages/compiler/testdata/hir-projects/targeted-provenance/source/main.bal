import ballerina/http;

client class Queue {
    public function init(string host, int port = 9092) { _ = host; _ = port; }
    remote function read(string topic = "jobs") returns string|error { return topic; }
    function label(string value) returns string => value;
    resource function get items/[string id]() returns string => id;
}
function index() returns int => 0;
function identity(string value) returns string => value;
function fill(Queue queue, string[] values) returns error? {
    values[index()] = check queue->read(topic = identity("orders"));
}
function fetch(Queue caller) returns string|error {
    return check caller->/items/[identity("café🚀")].get();
}
public function main() {
    Queue queue = new (identity("broker"), port = index());
    string text = queue.label(value = "සිංහල");
    _ = text;
}
service /api on new http:Listener(8080) {
    resource function get items/[string id]() returns string => id;
}
