client class Queue {
 remote function read() returns string|error { return "value"; }
 }
 function index() returns int { return 0; }
 function fill(Queue queue, string[] values) returns error? {
 values[index()] = check queue->read();
 }
 public function main() {}