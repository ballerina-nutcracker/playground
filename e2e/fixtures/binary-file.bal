import ballerina/io;

public function main() returns error? {
    check io:fileWriteBytes("binary.bin", [0xff, 0xfe, 0x00, 0x80]);
    io:println(check io:fileReadBytes("binary.bin"));
}
