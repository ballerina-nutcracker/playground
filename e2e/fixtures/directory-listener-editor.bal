import ballerina/file;
import ballerina/io;

listener file:Listener directory = check new ({path: "./somewhere"});

service on directory {
    remote function onCreate(file:FileEvent event) returns error? {
        io:println("create:", check file:basename(event.name));
    }

    remote function onModify(file:FileEvent event) returns error? {
        io:println("modify:", check file:basename(event.name));
    }

    remote function onDelete(file:FileEvent event) returns error? {
        io:println("delete:", check file:basename(event.name));
    }
}

public function main() returns error? {
    check directory.'start();
    io:println("ready");
}
