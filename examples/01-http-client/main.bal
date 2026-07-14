import ballerina/http;
import ballerina/io;

type Customer record {|
    int id;
    string name;
    string email;
    boolean subscribed;
|};

type Subscriber record {|
    string name;
    string email;
|};

public function main() returns error? {
    final http:Client apiClient = check new ("https://httpbun.com", {
        timeout: 10
    });

    Customer[] customers = [
        {id: 1, name: "Alice", email: "alice@example.com", subscribed: true},
        {id: 2, name: "Bob", email: "bob@example.com", subscribed: false},
        {id: 3, name: "Carol", email: "carol@example.com", subscribed: true}
    ];

    Subscriber[] subscribers = from var customer in customers
        where customer.subscribed
        select {
            name: customer.name,
            email: customer.email
        };

    http:Response response = check apiClient->post("/anything/subscribers", subscribers);
    io:println(string `[${response.statusCode}] Synced ${subscribers.length()} subscriber(s)`);
    foreach Subscriber subscriber in subscribers {
        io:println(string `  ${subscriber.name} <${subscriber.email}>`);
    }
}
