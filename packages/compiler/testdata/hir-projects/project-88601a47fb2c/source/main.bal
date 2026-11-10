import ballerina/http;
type Person record {| string first_name; string last_name; |};
final http:Client testClient = check new ("https://test.com");
service / on new http:Listener(8080) { resource function get hello() returns string|error { Person person = check testClient->get("/foo/bar"); return string `hello ${person.first_name} ${person.last_name}`; } }