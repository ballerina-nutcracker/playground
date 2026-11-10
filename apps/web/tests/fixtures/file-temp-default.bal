import ballerina/file;
import ballerina/io;

public function main() returns error? {
    string temp = check file:createTemp();
    string tempDir = check file:createTempDir();
    io:println(check file:test(temp, file:EXISTS));
    io:println(check file:test(tempDir, file:IS_DIR));
    check file:remove(temp);
    check file:remove(tempDir, file:RECURSIVE);
}
