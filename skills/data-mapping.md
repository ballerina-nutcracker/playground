---
name: data-mapping
description: Use when you need to map data transmitted over the wire
---

## XML data
- If the data is XML, use the Ballerina type `xml` and XML navigation expressions to access data; do not convert it to JSON or records just to read fields.
- Use `/<name>` to select direct child elements and chain navigation steps for nested elements. Use `/**/<name>` only when descendants at any depth are intended.
- Extract element text with `.children().data()`. XML navigation returns a sequence: validate required fields and cardinality before mapping, and iterate over repeated elements instead of concatenating their text.
- For namespaced XML, declare an `xmlns` prefix for the namespace URI and use qualified names in navigation. Match the URI, not the incoming document's choice of prefix.
- Construct XML output with an `xml` template and interpolate mapped values. Interpolated strings are escaped as XML text; do not build XML through string concatenation.

For an input such as `<location><line1>12</line1><line2>Flower Road</line2><line3>Colombo</line3></location>`:

```ballerina
function mapAddress(xml data) returns xml {
    string houseNumber = (data/<line1>).children().data();
    string streetName = (data/<line2>).children().data();
    string city = (data/<line3>).children().data();

    return xml `<address>
        <houseNumber>${houseNumber}</houseNumber>
        <streetName>${streetName}</streetName>
        <city>${city}</city>
        <country>Sri Lanka</country>
    </address>`;
}
```

This example assumes each input field occurs exactly once. Add validation when the wire format does not guarantee that shape.

## JSON data

- Define ballerina records for match json shapes
  - For input data use open records
  - For output data use closed records

- Define the variables using those types, ballerina runtime will handle the mapping
```ballerina
type Req record {
  decimal lat
  decimal long
};

type Payload record {|
  decimal latitude;
  decimal longitude;
|};

type Location record {
  string line1;
  string line2;
  string line3;
}

service / on new http:Listener(8080) {
    resource function post data(Req data) returns Address|error {
        Payload payload = {
            latitude: data.lat,
            longitude: data.long
        };
        Location location = check addressClient->post("/locate", payload);

        string houseNumber = location.line1;
        string streetName = location.line2;
        string city = location.line3;

        return {
            houseNumber: houseNumber,
            streetName: streetName,
            city: city,
            country: "Sri Lanka"
        };
    }
}
```
