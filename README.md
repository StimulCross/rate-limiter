# Rate Limiters

A collection of rate limiters designed primarily for **outbound request throttling**.

They are suited for client-side usage to respect third-party limits or protect internal resources.

While it is technically possible to use these limiters for server-side traffic backed by a distributed store like Redis, it is **not recommended**. The algorithms evaluate state within the application process, so distributed usage requires multiple network operations per request introducing significant round-trip latency.
