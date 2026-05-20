CREATE DATABASE parking_system;

USE parking_system;

CREATE TABLE parking_data(

    id INT PRIMARY KEY AUTO_INCREMENT,

    slot_name VARCHAR(20),

    status VARCHAR(20)

);