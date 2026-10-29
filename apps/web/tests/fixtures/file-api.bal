import ballerina/file;
import ballerina/io;

public function main() returns error? {
    string base = "/tmp/file-api";
    check file:createDir(base + "/nested", file:RECURSIVE);
    check file:create(base + "/source.txt");

    file:MetaData metadata = check file:getMetaData(base + "/source.txt");
    io:println(metadata.readable);
    io:println((check file:readDir(base)).length());
    io:println(check file:getCurrentDir() == "/tmp");
    io:println(check file:getAbsolutePath("./source.txt") == "/tmp/./source.txt");

    string copy = "/tmp/file-api-copy";
    check file:copy(base, copy);
    io:println(check file:test(copy + "/source.txt", file:EXISTS));

    check file:rename(base + "/source.txt", base + "/renamed.txt");
    io:println(check file:test(base + "/renamed.txt", file:EXISTS));
    io:println(check file:test(base + "/source.txt", file:EXISTS));
    io:println(check file:test(base + "/renamed.txt", file:IS_SYMLINK));

    string temp = check file:createTemp(prefix = "test-", suffix = ".txt");
    string tempDir = check file:createTempDir(prefix = "test-dir-");
    io:println(check file:test(temp, file:EXISTS));
    io:println(check file:test(tempDir, file:IS_DIR));
    check file:remove(temp);
    check file:remove(tempDir, file:RECURSIVE);

    check file:remove(base, file:RECURSIVE);
    check file:remove(copy, file:RECURSIVE);
    io:println(check file:test(base, file:EXISTS));
}
