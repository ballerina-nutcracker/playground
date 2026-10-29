import ballerina/file;
import ballerina/io;

public function main() returns error? {
    string temp = check file:createTemp();
    string tempDir = check file:createTempDir();
    io:println(check file:test(temp, file:EXISTS));
    io:println(check file:test(tempDir, file:IS_DIR));
    io:println(check file:parentPath(temp));
    io:println(check file:parentPath(tempDir));
    check file:remove(temp);
    check file:remove(tempDir, file:RECURSIVE);
}
