import ballerina/file;
import ballerina/io;
import ballerina/lang.runtime;

isolated int deletes = 0;

service class Svc {
    *file:Service;

    remote function onDelete(file:FileEvent e) {
        if e.name.length() > 0 {
            lock {
                deletes += 1;
            }
        }
    }
}

public function main() returns error? {
    check file:createDir("/tmp/bulk-remove/bulk", file:RECURSIVE);
    foreach int i in 0 ..< 3 {
        check file:create(string `/tmp/bulk-remove/bulk/f${i}.txt`);
    }
    file:Listener dir = check new ({path: "/tmp/bulk-remove", recursive: true});
    check dir.attach(new Svc());
    check dir.'start();
    check file:remove("/tmp/bulk-remove/bulk", file:RECURSIVE);
    runtime:sleep(1);
    lock {
        io:println("deletes: ", deletes);
    }
    check dir.gracefulStop();
    check file:remove("/tmp/bulk-remove", file:RECURSIVE);
}
