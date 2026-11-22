import ballerina/file;
import ballerina/io;

listener file:Listener directory = check new ({path: ".", recursive: true});

service on directory {
    remote function onCreate(file:FileEvent event) returns error? {
        string name = check file:basename(event.name);
        if name == "changes" {
            check file:create(event.name + "/item.txt");
        } else if name == "item.txt" {
            io:println("create:item.txt");
            check io:fileWriteString(event.name, "updated", io:APPEND);
        } else if name == "renamed.txt" {
            io:println("create:renamed.txt");
            // Stopping from inside a handler must not deadlock or dispatch
            // subsequent events through the released callback.
            check directory.gracefulStop();
            check directory.gracefulStop();
            check file:create("changes/ignored.txt");
            check file:remove("changes", file:RECURSIVE);
            io:println("watch stopped");
        } else {
            io:println("unexpected:", name);
        }
    }

    remote function onModify(file:FileEvent event) returns error? {
        io:println("modify:", check file:basename(event.name));
        check file:rename(event.name, "changes/renamed.txt");
    }

    remote function onDelete(file:FileEvent event) returns error? {
        io:println("delete:", check file:basename(event.name));
    }
}

public function main() returns error? {
    check directory.'start();
    check file:createDir("changes");
}
