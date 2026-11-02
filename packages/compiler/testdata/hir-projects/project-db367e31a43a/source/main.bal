client class Queue {
   public function init(string host, int port = 12) { _ = host; _ = port; }
   remote function send(string message, string topic = "jobs") returns string|error { return topic + message; }
 }
 final Queue globalQueue = new ("host", port = 99);
 function makeQueue() returns Queue { return new ("factory"); }
 function run(Queue inputQueue) returns error? {
   string first = check globalQueue->send("one", topic = "orders");
   Queue local = makeQueue();
   string second = check local->send("two");
   local = new ("replacement");
   string third = check local->send("three");
   string fourth = check inputQueue->send("four");
 _ = first; _ = second; _ = third; _ = fourth;
   { Queue globalQueue = new ("shadow"); string fifth = check globalQueue->send("five"); _ = fifth; }
 }
 public function main() {}