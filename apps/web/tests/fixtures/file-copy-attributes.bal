import ballerina/file;
import ballerina/io;

public function main() returns error? {
    string src = "/tmp/source.txt";
    file:MetaData srcMeta = check file:getMetaData(src);

    check file:copy(src, "/tmp/with-attrs.txt", file:COPY_ATTRIBUTES);
    file:MetaData withAttrs = check file:getMetaData("/tmp/with-attrs.txt");
    io:println(withAttrs.modifiedTime == srcMeta.modifiedTime);

    check file:copy(src, "/tmp/without-attrs.txt");
    file:MetaData withoutAttrs = check file:getMetaData("/tmp/without-attrs.txt");
    io:println(withoutAttrs.modifiedTime == srcMeta.modifiedTime);
}
