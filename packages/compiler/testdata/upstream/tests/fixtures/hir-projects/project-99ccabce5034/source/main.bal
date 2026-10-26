import ballerina/http;
import ballerina/io;
service / on new http:Listener(8080) {
 resource function get hello() returns string { return "Hello, World!"; }
 resource function get [int x]/[int y]/sum() returns int {
  io:println("x: ", x, ", y: ", y);
  return fib(x) + fib(y);
 }
}
function fib(int n) returns int {
 if n <= 1 { return n; }
 return fib(n - 1) + fib(n - 2);
}