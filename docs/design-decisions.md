moved away from a dediciated etl looked like prefect
reasons was because a dedicated etl was overkill for my needs

decided to use inngest as queueing retry logic
reasons why included easy set up. hosted
other alternatives that were considered were bullMQ+redis and temporal
reasons why i didnt choose the bullmq+redis and temporal options includes have to self host redis and temporal is expenseice and overkill

the api to database workflow will look like the following using inngest

inngest docker

docker run -p 8288:8288 inngest/inngest \
 inngest dev -u http://host.docker.internal:8000/api/inngest --no-discovery

External APIs (Squarespace, Revolut, etc.)
↓ (webhooks/polling)
API Gateway / Load Balancer
↓
Integration Service
↓
Message Queue (optional but recommended)
↓
Worker Processes
↓
Data Transformation Layer
↓
Database (PostgreSQL/MongoDB)
