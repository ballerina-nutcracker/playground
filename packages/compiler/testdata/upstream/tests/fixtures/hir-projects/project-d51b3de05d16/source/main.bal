import ballerina/http;
service /orders on new http:Listener(8080) {
    resource function get [int id](boolean includeItems = false) returns string { _ = id; _ = includeItems; return "order"; }
    remote function refresh(string note = "") returns boolean { _ = note; return true; }
}
class PricingEngine {
    function quote(decimal subtotal) returns decimal { return subtotal; }
}
function calculateTax(decimal amount, decimal rate = 0.15) returns decimal { return amount * rate; }
function identity(int value) returns int => value;
public function main() {}
