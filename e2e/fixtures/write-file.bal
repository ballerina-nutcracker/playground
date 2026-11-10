import ballerina/io;

public function main() returns error? {
    check io:fileWriteString("generated/runtime-file.txt", "Hello, Ballerina");
    io:println("file written");
}
